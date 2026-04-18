import * as crypto from 'crypto';
import { DataSourceConfig } from '../config/configSchema';
import { EmbeddingProvider } from '../embedding/embeddingProvider';
import { GitHubFetcher } from '../sources/github/githubFetcher';
import { DeltaSync } from '../sources/sync/deltaSync';
import { FileFilter } from './fileFilter';
import { Chunker } from './chunker';
import { ParserRegistry } from './parserRegistry';
import { ProgressTracker } from './progressTracker';
import { ChunkStore, ChunkRecord } from '../storage/chunkStore';
import { EmbeddingStore } from '../storage/embeddingStore';
import { SyncStore } from '../storage/syncStore';

const MAX_CONCURRENCY = 3;
const LARGE_REPO_THRESHOLD = 10_000;

export interface PipelineConfigSource {
  getDataSource(id: string): DataSourceConfig | undefined;
  getDefaultExcludePatterns(): string[];
  updateDataSource(id: string, updates: Partial<DataSourceConfig>): void;
}

export interface PipelineEmbeddingSource {
  getProvider(): Promise<EmbeddingProvider>;
}

export interface PipelineLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PipelineProgress {
  report(message: string, increment?: number): void;
}

export class IngestionPipeline {
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private disposed = false;
  private readonly _onIndexingError: ((dataSourceId: string, message: string) => void)[] = [];

  constructor(
    private readonly config: PipelineConfigSource,
    private readonly embeddingSource: PipelineEmbeddingSource,
    private readonly fetcher: GitHubFetcher,
    private readonly chunkStore: ChunkStore,
    private readonly embeddingStore: EmbeddingStore,
    private readonly syncStore: SyncStore,
    private readonly logger: PipelineLogger,
    private readonly deltaSync?: DeltaSync,
    private readonly parserRegistry?: ParserRegistry,
    private readonly progressTracker?: ProgressTracker,
  ) {}

  onIndexingError(handler: (dataSourceId: string, message: string) => void): void {
    this._onIndexingError.push(handler);
  }

  get queueSize(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running.size;
  }

  enqueue(dataSourceId: string): void {
    if (this.disposed) return;
    if (this.queue.includes(dataSourceId) || this.running.has(dataSourceId)) {
      return;
    }
    this.queue.push(dataSourceId);
    this.config.updateDataSource(dataSourceId, { status: 'queued' });
    this.processQueue();
  }

  private processQueue(): void {
    while (this.running.size < MAX_CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.running.add(id);
      this.ingestDataSource(id).finally(() => {
        this.running.delete(id);
        if (!this.disposed) {
          this.processQueue();
        }
      });
    }
  }

  async ingestDataSource(dataSourceId: string, progress?: PipelineProgress): Promise<void> {
    const ds = this.config.getDataSource(dataSourceId);
    if (!ds) return;

    const syncId = crypto.randomUUID();
    let commitSha: string | null = null;

    try {
      this.config.updateDataSource(dataSourceId, { status: 'indexing' });
      this.logger.info(`Indexing ${ds.owner}/${ds.repo}@${ds.branch}`);
      progress?.report(`Fetching ${ds.owner}/${ds.repo}...`);

      // Get current HEAD
      commitSha = await this.fetcher.getBranchSha(ds.owner, ds.repo, ds.branch);
      this.syncStore.startSync(syncId, dataSourceId, commitSha);

      // Try delta sync if we have a previous commit
      if (ds.lastSyncCommitSha && this.deltaSync && commitSha !== ds.lastSyncCommitSha) {
        const didDelta = await this.tryDeltaSync(
          ds, dataSourceId, syncId, commitSha, progress,
        );
        if (didDelta) return;
        // Delta failed — fall through to full re-index
        this.logger.warn(`Delta sync failed for ${ds.owner}/${ds.repo}, falling back to full re-index`);
      }

      await this.fullReindex(ds, dataSourceId, syncId, commitSha, progress);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.config.updateDataSource(dataSourceId, {
        status: 'error',
        errorMessage: message,
      });
      this.progressTracker?.complete(dataSourceId);
      try { this.syncStore.failSync(syncId, message); } catch { /* best-effort */ }
      this.logger.error(`Indexing failed for ${ds.owner}/${ds.repo}: ${message}`);
      for (const handler of this._onIndexingError) {
        handler(dataSourceId, message);
      }
    }
  }

  private async tryDeltaSync(
    ds: DataSourceConfig,
    dataSourceId: string,
    syncId: string,
    commitSha: string,
    progress?: PipelineProgress,
  ): Promise<boolean> {
    try {
      const delta = await this.deltaSync!.computeDelta(
        ds.owner, ds.repo, ds.lastSyncCommitSha!, commitSha,
      );

      const filter = this.buildFilter(ds);
      const addedFiltered = delta.added.filter((e) => filter.matches(e.path));
      const modifiedFiltered = delta.modified.filter((e) => filter.matches(e.path));
      const deletedFiltered = delta.deleted.filter((p) => filter.matches(p));

      const totalChanges = addedFiltered.length + modifiedFiltered.length + deletedFiltered.length;
      this.logger.info(
        `Delta: ${addedFiltered.length} added, ${modifiedFiltered.length} modified, ${deletedFiltered.length} deleted`,
      );
      progress?.report(`Processing ${totalChanges} changed files...`);

      // Delete chunks for removed and modified files
      for (const filePath of deletedFiltered) {
        const chunkIds = this.chunkStore.getChunkIdsByFile(dataSourceId, filePath);
        this.embeddingStore.deleteByChunkIds(chunkIds);
        this.chunkStore.deleteByFile(dataSourceId, filePath);
      }
      for (const entry of modifiedFiltered) {
        const chunkIds = this.chunkStore.getChunkIdsByFile(dataSourceId, entry.path);
        this.embeddingStore.deleteByChunkIds(chunkIds);
        this.chunkStore.deleteByFile(dataSourceId, entry.path);
      }

      // Fetch and chunk added + modified files
      const toFetch = [...addedFiltered, ...modifiedFiltered];
      if (toFetch.length > 0) {
        this.progressTracker?.start(dataSourceId, toFetch.length);
        const files = await this.fetcher.fetchFiles(ds.owner, ds.repo, toFetch);
        const provider = await this.embeddingSource.getProvider();
        const chunker = new Chunker({
          countTokens: provider.countTokens
            ? (text: string) => provider.countTokens!(text)
            : undefined,
          maxInputTokens: provider.maxInputTokens,
          astDeps: this.parserRegistry
            ? { parserRegistry: this.parserRegistry, logger: this.logger }
            : undefined,
        });

        const allChunks: ChunkRecord[] = [];
        for (const file of files) {
          const chunks = await chunker.chunkFile(file.content, file.path);
          const fileChunks: ChunkRecord[] = [];
          for (const chunk of chunks) {
            fileChunks.push({
              id: crypto.randomUUID(),
              dataSourceId,
              filePath: file.path,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              content: chunk.content,
              tokenCount: chunk.tokenCount,
            });
          }
          allChunks.push(...fileChunks);
          const fileTokens = fileChunks.reduce((sum, c) => sum + c.tokenCount, 0);
          this.progressTracker?.fileProcessed(dataSourceId, fileChunks.length, fileTokens);
        }

        this.chunkStore.insertMany(allChunks);
        await this.embedChunks(allChunks, provider, progress);
      }

      this.config.updateDataSource(dataSourceId, {
        status: 'ready',
        lastSyncedAt: new Date().toISOString(),
        lastSyncCommitSha: commitSha,
      });
      this.progressTracker?.complete(dataSourceId);
      this.syncStore.completeSync(syncId, toFetch.length, this.chunkStore.countByDataSource(dataSourceId));
      this.logger.info(`Delta sync complete for ${ds.owner}/${ds.repo}`);
      return true;
    } catch {
      return false;
    }
  }

  private async fullReindex(
    ds: DataSourceConfig,
    dataSourceId: string,
    syncId: string,
    commitSha: string,
    progress?: PipelineProgress,
  ): Promise<void> {
    // Fetch file tree
    const { entries: tree, truncated } = await this.fetcher.getTree(ds.owner, ds.repo, commitSha);
    if (truncated) {
      this.logger.warn(`File tree for ${ds.owner}/${ds.repo} was truncated by GitHub API`);
    }

    const filter = this.buildFilter(ds);
    const filteredEntries = tree.filter((entry) => filter.matches(entry.path));

    if (filteredEntries.length > LARGE_REPO_THRESHOLD) {
      this.logger.warn(
        `Large repository: ${filteredEntries.length} files after filtering for ${ds.owner}/${ds.repo}`,
      );
    }

    this.logger.info(`Fetching ${filteredEntries.length} files`);
    progress?.report(`Fetching ${filteredEntries.length} files...`);
    this.progressTracker?.start(dataSourceId, filteredEntries.length);

    // Clear existing data for this source (full re-index)
    const oldChunkIds = this.chunkStore.getChunkIdsByDataSource(dataSourceId);
    this.embeddingStore.deleteByChunkIds(oldChunkIds);
    this.chunkStore.deleteByDataSource(dataSourceId);

    // Fetch file contents in a single tarball request rather than one blob
    // call per file — saves ~N GitHub API calls on large repos.
    const files = await this.fetcher.fetchAllFiles(ds.owner, ds.repo, commitSha, filteredEntries);

    // Get embedding provider and build chunker
    const provider = await this.embeddingSource.getProvider();
    const chunker = new Chunker({
      countTokens: provider.countTokens
        ? (text: string) => provider.countTokens!(text)
        : undefined,
      maxInputTokens: provider.maxInputTokens,
      astDeps: this.parserRegistry
        ? { parserRegistry: this.parserRegistry, logger: this.logger }
        : undefined,
    });

    // Chunk all files
    const allChunks: ChunkRecord[] = [];
    for (const file of files) {
      const chunks = await chunker.chunkFile(file.content, file.path);
      const fileChunks: ChunkRecord[] = [];
      for (const chunk of chunks) {
        fileChunks.push({
          id: crypto.randomUUID(),
          dataSourceId,
          filePath: file.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
        });
      }
      allChunks.push(...fileChunks);
      const fileTokens = fileChunks.reduce((sum, c) => sum + c.tokenCount, 0);
      this.progressTracker?.fileProcessed(dataSourceId, fileChunks.length, fileTokens);
    }

    // Store chunks
    this.chunkStore.insertMany(allChunks);
    progress?.report(`Embedding ${allChunks.length} chunks...`);

    // Embed in batches
    await this.embedChunks(allChunks, provider, progress);

    // Update state
    this.config.updateDataSource(dataSourceId, {
      status: 'ready',
      lastSyncedAt: new Date().toISOString(),
      lastSyncCommitSha: commitSha,
    });
    this.progressTracker?.complete(dataSourceId);
    this.syncStore.completeSync(syncId, files.length, allChunks.length);
    this.logger.info(`Indexed ${allChunks.length} chunks from ${files.length} files`);
  }

  private buildFilter(ds: DataSourceConfig): FileFilter {
    return new FileFilter(
      ds.includePatterns,
      [...ds.excludePatterns, ...this.config.getDefaultExcludePatterns()],
    );
  }

  private async embedChunks(
    chunks: ChunkRecord[],
    provider: EmbeddingProvider,
    progress?: PipelineProgress,
  ): Promise<void> {
    const batchSize = provider.maxBatchSize;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await provider.embed(texts);

      const items = batch.map((chunk, idx) => ({
        chunkId: chunk.id,
        embedding: embeddings[idx],
      }));
      this.embeddingStore.insertMany(items);
      progress?.report(`Embedded ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks`);
    }
  }

  async removeDataSource(dataSourceId: string): Promise<void> {
    const chunkIds = this.chunkStore.getChunkIdsByDataSource(dataSourceId);
    this.embeddingStore.deleteByChunkIds(chunkIds);
    this.chunkStore.deleteByDataSource(dataSourceId);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }
}
