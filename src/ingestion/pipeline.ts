import * as crypto from 'crypto';
import { DataSourceConfig } from '../config/configSchema';
import { EmbeddingProvider } from '../embedding/embeddingProvider';
import { filterEligibleEntries, GitHubFetcher } from '../sources/github/githubFetcher';
import { FetchedFile } from '../sources/dataSource';
import { DeltaSync } from '../sources/sync/deltaSync';
import { FileFilter } from './fileFilter';
import { Chunker } from './chunker';
import { ParserRegistry } from './parserRegistry';
import { ProgressTracker } from './progressTracker';
import { ChunkStore, ChunkRecord } from '../storage/chunkStore';
import { EmbeddingStore } from '../storage/embeddingStore';
import { SyncResultDetails, SyncStore } from '../storage/syncStore';
import { IndexingRunStore } from '../storage/indexingRunStore';

const MAX_CONCURRENCY = 3;
const LARGE_REPO_THRESHOLD = 10_000;
const TARBALL_MAX_ATTEMPTS = 2;

export interface PipelineConfigSource {
  getDataSource(id: string): DataSourceConfig | undefined;
  getDefaultExcludePatterns(): string[];
  updateDataSource(id: string, updates: Partial<DataSourceConfig>): void;
}

export interface PipelineEmbeddingSource {
  getProvider(): Promise<EmbeddingProvider>;
}

export interface PipelineLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PipelineProgress {
  report(message: string, increment?: number): void;
}

interface IndexingContext {
  commitSha: string | null;
  totalFiles: number;
  processedFiles: number;
  lastFilePath: string | null;
  fetchStrategy: string | null;
  runId: string | null;
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
    private readonly indexingRunStore: IndexingRunStore,
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
    const context: IndexingContext = {
      commitSha: null,
      totalFiles: 0,
      processedFiles: 0,
      lastFilePath: null,
      fetchStrategy: null,
      runId: null,
    };

    try {
      this.config.updateDataSource(dataSourceId, {
        status: 'indexing',
        errorMessage: undefined,
      });
      this.logger.info(`Indexing ${ds.owner}/${ds.repo}@${ds.branch}`);
      progress?.report(`Fetching ${ds.owner}/${ds.repo}...`);

      context.commitSha = await this.runStage(
        'GitHub branch lookup',
        ds,
        context,
        () => this.fetcher.getBranchSha(ds.owner, ds.repo, ds.branch),
      );

      this.syncStore.startSync(syncId, dataSourceId, context.commitSha);

      if (ds.lastSyncCommitSha && this.deltaSync && context.commitSha !== ds.lastSyncCommitSha) {
        const didDelta = await this.tryDeltaSync(ds, dataSourceId, syncId, context, progress);
        if (didDelta) return;
        this.logger.warn(`Delta sync failed for ${ds.owner}/${ds.repo}, falling back to full re-index`);
      }

      await this.fullReindex(ds, dataSourceId, syncId, context, progress);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const details = this.buildSyncDetails(context);
      this.config.updateDataSource(dataSourceId, {
        status: 'error',
        errorMessage: message,
      });
      this.progressTracker?.complete(dataSourceId);
      if (context.runId) {
        this.indexingRunStore.failRun(context.runId, context.fetchStrategy ?? undefined);
      }
      try {
        this.syncStore.failSync(syncId, message, details);
      } catch {
        // Best-effort sync history update
      }
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
    context: IndexingContext,
    progress?: PipelineProgress,
  ): Promise<boolean> {
    try {
      const delta = await this.runStage(
        'GitHub compare API',
        ds,
        context,
        () => this.deltaSync!.computeDelta(
          ds.owner,
          ds.repo,
          ds.lastSyncCommitSha!,
          context.commitSha!,
        ),
      );

      const filter = this.buildFilter(ds);
      const addedFiltered = delta.added.filter((e) => filter.matches(e.path));
      const modifiedFiltered = delta.modified.filter((e) => filter.matches(e.path));
      const deletedFiltered = delta.deleted.filter((p) => filter.matches(p));

      const totalChanges = addedFiltered.length + modifiedFiltered.length + deletedFiltered.length;
      context.totalFiles = totalChanges;
      context.fetchStrategy = 'blob';
      this.logger.info(
        `Delta: ${addedFiltered.length} added, ${modifiedFiltered.length} modified, ${deletedFiltered.length} deleted`,
      );
      progress?.report(`Processing ${totalChanges} changed files...`);

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

      const toFetch = [...addedFiltered, ...modifiedFiltered];
      if (toFetch.length > 0) {
        this.progressTracker?.start(dataSourceId, toFetch.length);
        const files = await this.runStage(
          'GitHub blob fallback',
          ds,
          context,
          () => this.fetcher.fetchFiles(ds.owner, ds.repo, toFetch),
        );
        const provider = await this.embeddingSource.getProvider();
        const chunker = this.createChunker(provider);

        const allChunks: ChunkRecord[] = [];
        for (const file of files) {
          context.lastFilePath = file.path;
          const chunks = await this.runStage(
            'Chunking file',
            ds,
            context,
            () => chunker.chunkFile(file.content, file.path),
          );
          const fileChunks = chunks.map((chunk) => ({
            id: crypto.randomUUID(),
            dataSourceId,
            filePath: file.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
          }));
          allChunks.push(...fileChunks);
          const fileTokens = fileChunks.reduce((sum, c) => sum + c.tokenCount, 0);
          this.progressTracker?.fileProcessed(dataSourceId, fileChunks.length, fileTokens);
        }

        this.chunkStore.insertMany(allChunks);
        await this.embedChunks(allChunks, provider, progress, ds, context);
      }

      this.config.updateDataSource(dataSourceId, {
        status: 'ready',
        lastSyncedAt: new Date().toISOString(),
        lastSyncCommitSha: context.commitSha,
      });
      this.progressTracker?.complete(dataSourceId);
      this.syncStore.completeSync(syncId, {
        filesProcessed: toFetch.length,
        filesTotal: totalChanges,
        chunksCreated: this.chunkStore.countByDataSource(dataSourceId),
        tokensIndexed: this.chunkStore.getDataSourceStats(dataSourceId).totalTokens,
        fetchStrategy: context.fetchStrategy ?? undefined,
        lastFilePath: context.lastFilePath,
      });
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
    context: IndexingContext,
    progress?: PipelineProgress,
  ): Promise<void> {
    const { entries: tree, truncated } = await this.runStage(
      'GitHub tree fetch',
      ds,
      context,
      () => this.fetcher.getTree(ds.owner, ds.repo, context.commitSha!),
    );
    if (truncated) {
      this.logger.warn(`File tree for ${ds.owner}/${ds.repo} was truncated by GitHub API`);
    }

    const filter = this.buildFilter(ds);
    const filteredEntries = tree.filter((entry) => filter.matches(entry.path));
    const eligibleEntries = filterEligibleEntries(filteredEntries);
    if (filteredEntries.length > LARGE_REPO_THRESHOLD) {
      this.logger.warn(
        `Large repository: ${filteredEntries.length} files after filtering for ${ds.owner}/${ds.repo}`,
      );
    }
    if (eligibleEntries.length !== filteredEntries.length) {
      this.logger.info(
        `Skipping ${filteredEntries.length - eligibleEntries.length} binary or oversized files for ${ds.owner}/${ds.repo}`,
      );
    }

    const runKey = this.buildRunKey(context.commitSha!, ds, this.config.getDefaultExcludePatterns());
    const run = this.indexingRunStore.startOrResumeRun(
      dataSourceId,
      runKey,
      context.commitSha!,
      eligibleEntries,
    );
    context.runId = run.id;

    const initialSummary = this.indexingRunStore.getSummary(run.id);
    context.totalFiles = run.totalFiles;
    context.processedFiles = initialSummary.completedFiles;
    this.progressTracker?.start(
      dataSourceId,
      run.totalFiles,
      initialSummary.completedFiles,
      initialSummary.tokenCount,
    );

    const provider = await this.embeddingSource.getProvider();
    const chunker = this.createChunker(provider);
    let pending = this.indexingRunStore.getPendingFiles(run.id);
    let tarballFailed = false;

    if (pending.length > 0) {
      this.logger.info(
        `Processing ${pending.length}/${run.totalFiles} pending files for ${ds.owner}/${ds.repo}`,
      );
    }

    for (let attempt = 1; attempt <= TARBALL_MAX_ATTEMPTS && pending.length > 0; attempt++) {
      context.fetchStrategy = 'tarball';
      this.indexingRunStore.setFetchStrategy(run.id, context.fetchStrategy);
      progress?.report(`Streaming ${pending.length} files from GitHub tarball...`);

      try {
        await this.runStage(
          'GitHub tarball stream',
          ds,
          context,
          () => this.fetcher.streamTarballFiles(
            ds.owner,
            ds.repo,
            context.commitSha!,
            pending,
            async (file) => {
              await this.processFetchedFile(
                ds,
                dataSourceId,
                run.id,
                file,
                provider,
                chunker,
                context,
                progress,
              );
            },
          ),
        );
        pending = this.indexingRunStore.getPendingFiles(run.id);
        if (pending.length === 0) break;
      } catch (err) {
        tarballFailed = true;
        pending = this.indexingRunStore.getPendingFiles(run.id);
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Tarball attempt ${attempt}/${TARBALL_MAX_ATTEMPTS} failed for ${ds.owner}/${ds.repo}: ${message}`,
        );
        if (attempt === TARBALL_MAX_ATTEMPTS) {
          break;
        }
      }
    }

    pending = this.indexingRunStore.getPendingFiles(run.id);
    if (pending.length > 0) {
      context.fetchStrategy = tarballFailed ? 'tarball+blob-fallback' : 'blob';
      this.indexingRunStore.setFetchStrategy(run.id, context.fetchStrategy);
      this.logger.warn(
        `Falling back to blob fetch for ${pending.length} remaining files in ${ds.owner}/${ds.repo}`,
      );
      progress?.report(`Falling back to per-file fetch for ${pending.length} files...`);
      await this.fetcher.streamBlobFiles(
        ds.owner,
        ds.repo,
        pending,
        async (file) => {
          await this.processFetchedFile(
            ds,
            dataSourceId,
            run.id,
            file,
            provider,
            chunker,
            context,
            progress,
          );
        },
        {
          onFileError: async (entry, err) => {
            context.lastFilePath = entry.path;
            this.indexingRunStore.markFileFailed(
              run.id,
              entry.path,
              this.formatStageError('GitHub blob fallback', ds, context, err, entry.path),
            );
          },
        },
      );
    }

    const remaining = this.indexingRunStore.getPendingFiles(run.id);
    if (remaining.length > 0) {
      const firstFailed = this.indexingRunStore
        .getAllFiles(run.id)
        .find((file) => file.status !== 'completed');
      if (firstFailed) {
        context.lastFilePath = firstFailed.filePath;
        throw new Error(firstFailed.errorMessage ?? this.formatIncompleteRunMessage(ds, context));
      }
      throw new Error(this.formatIncompleteRunMessage(ds, context));
    }

    await this.removeStaleFiles(dataSourceId, run.id);
    const summary = this.indexingRunStore.getSummary(run.id);
    context.processedFiles = summary.completedFiles;
    this.indexingRunStore.completeRun(run.id, context.fetchStrategy ?? undefined);

    this.config.updateDataSource(dataSourceId, {
      status: 'ready',
      lastSyncedAt: new Date().toISOString(),
      lastSyncCommitSha: context.commitSha,
      errorMessage: undefined,
    });
    this.progressTracker?.complete(dataSourceId);

    const details: SyncResultDetails = {
      filesProcessed: summary.completedFiles,
      filesTotal: summary.totalFiles,
      chunksCreated: summary.chunkCount,
      tokensIndexed: summary.tokenCount,
      fetchStrategy: context.fetchStrategy ?? undefined,
      lastFilePath: context.lastFilePath,
    };
    this.syncStore.completeSync(syncId, details);
    this.logger.info(
      `Indexed ${summary.chunkCount} chunks from ${summary.completedFiles}/${summary.totalFiles} files`,
    );
  }

  private async processFetchedFile(
    ds: DataSourceConfig,
    dataSourceId: string,
    runId: string,
    file: FetchedFile,
    provider: EmbeddingProvider,
    chunker: Chunker,
    context: IndexingContext,
    progress?: PipelineProgress,
  ): Promise<void> {
    context.lastFilePath = file.path;

    try {
      const chunks = await this.runStage(
        'Chunking file',
        ds,
        context,
        () => chunker.chunkFile(file.content, file.path),
        file.path,
      );
      const fileChunks = chunks.map((chunk) => ({
        id: crypto.randomUUID(),
        dataSourceId,
        filePath: file.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
      }));
      const fileTokens = fileChunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);

      const oldChunkIds = this.chunkStore.getChunkIdsByFile(dataSourceId, file.path);
      this.embeddingStore.deleteByChunkIds(oldChunkIds);
      this.chunkStore.deleteByFile(dataSourceId, file.path);

      if (fileChunks.length > 0) {
        this.chunkStore.insertMany(fileChunks);
        await this.embedChunks(fileChunks, provider, progress, ds, context, file.path);
      }

      this.indexingRunStore.markFileCompleted(runId, file.path, fileChunks.length, fileTokens);
      this.progressTracker?.fileProcessed(dataSourceId, fileChunks.length, fileTokens);
      const summary = this.indexingRunStore.getSummary(runId);
      context.processedFiles = summary.completedFiles;
      progress?.report(`Indexed ${summary.completedFiles}/${summary.totalFiles} files...`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.indexingRunStore.markFileFailed(runId, file.path, message);
      this.logger.warn(message);
    }
  }

  private async removeStaleFiles(dataSourceId: string, runId: string): Promise<void> {
    const manifestPaths = new Set(this.indexingRunStore.getAllFiles(runId).map((file) => file.filePath));
    for (const file of this.chunkStore.getFileStats(dataSourceId)) {
      if (manifestPaths.has(file.filePath)) continue;
      const chunkIds = this.chunkStore.getChunkIdsByFile(dataSourceId, file.filePath);
      this.embeddingStore.deleteByChunkIds(chunkIds);
      this.chunkStore.deleteByFile(dataSourceId, file.filePath);
    }
  }

  private buildFilter(ds: DataSourceConfig): FileFilter {
    return new FileFilter(
      ds.includePatterns,
      [...ds.excludePatterns, ...this.config.getDefaultExcludePatterns()],
    );
  }

  private createChunker(provider: EmbeddingProvider): Chunker {
    return new Chunker({
      countTokens: provider.countTokens
        ? (text: string) => provider.countTokens(text)
        : undefined,
      maxInputTokens: provider.maxInputTokens,
      astDeps: this.parserRegistry
        ? { parserRegistry: this.parserRegistry, logger: this.logger }
        : undefined,
    });
  }

  private async embedChunks(
    chunks: ChunkRecord[],
    provider: EmbeddingProvider,
    progress: PipelineProgress | undefined,
    ds: DataSourceConfig,
    context: IndexingContext,
    filePath?: string,
  ): Promise<void> {
    const batchSize = provider.maxBatchSize;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await this.runStage(
        'Embedding batch',
        ds,
        context,
        () => provider.embed(texts),
        filePath,
      );
      const items = batch.map((chunk, idx) => ({
        chunkId: chunk.id,
        embedding: embeddings[idx],
      }));
      this.embeddingStore.insertMany(items);
      progress?.report(`Embedded ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks`);
    }
  }

  private async runStage<T>(
    stage: string,
    ds: DataSourceConfig,
    context: IndexingContext,
    fn: () => Promise<T>,
    filePath?: string,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new Error(this.formatStageError(stage, ds, context, err, filePath));
    }
  }

  private formatStageError(
    stage: string,
    ds: DataSourceConfig,
    context: IndexingContext,
    err: unknown,
    filePath?: string,
  ): string {
    const parts = [`${stage} failed for ${ds.owner}/${ds.repo}@${ds.branch}`];
    if (context.commitSha) {
      parts.push(`commit ${shortSha(context.commitSha)}`);
    }
    if (context.totalFiles > 0) {
      parts.push(`${context.processedFiles}/${context.totalFiles} files`);
    }
    if (context.fetchStrategy) {
      parts.push(`strategy ${context.fetchStrategy}`);
    }
    const targetPath = filePath ?? context.lastFilePath;
    if (targetPath) {
      parts.push(`last file ${targetPath}`);
    }
    const cause = err instanceof Error ? err.message : String(err);
    return `${parts.join(' · ')}: ${cause}`;
  }

  private formatIncompleteRunMessage(ds: DataSourceConfig, context: IndexingContext): string {
    const parts = [`Indexing run incomplete for ${ds.owner}/${ds.repo}@${ds.branch}`];
    if (context.commitSha) {
      parts.push(`commit ${shortSha(context.commitSha)}`);
    }
    if (context.totalFiles > 0) {
      parts.push(`${context.processedFiles}/${context.totalFiles} files`);
    }
    if (context.fetchStrategy) {
      parts.push(`strategy ${context.fetchStrategy}`);
    }
    if (context.lastFilePath) {
      parts.push(`last file ${context.lastFilePath}`);
    }
    return parts.join(' · ');
  }

  private buildRunKey(
    commitSha: string,
    ds: DataSourceConfig,
    defaultExcludePatterns: string[],
  ): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        commitSha,
        includePatterns: ds.includePatterns,
        excludePatterns: [...ds.excludePatterns, ...defaultExcludePatterns],
      }))
      .digest('hex');
  }

  private buildSyncDetails(context: IndexingContext): Partial<SyncResultDetails> {
    if (!context.runId) {
      return {
        filesProcessed: context.processedFiles,
        filesTotal: context.totalFiles,
        fetchStrategy: context.fetchStrategy ?? undefined,
        lastFilePath: context.lastFilePath,
      };
    }

    const summary = this.indexingRunStore.getSummary(context.runId);
    return {
      filesProcessed: summary.completedFiles,
      filesTotal: summary.totalFiles,
      chunksCreated: summary.chunkCount,
      tokensIndexed: summary.tokenCount,
      fetchStrategy: context.fetchStrategy ?? undefined,
      lastFilePath: context.lastFilePath,
    };
  }

  async removeDataSource(dataSourceId: string): Promise<void> {
    const chunkIds = this.chunkStore.getChunkIdsByDataSource(dataSourceId);
    this.embeddingStore.deleteByChunkIds(chunkIds);
    this.chunkStore.deleteByDataSource(dataSourceId);
    this.indexingRunStore.deleteByDataSource(dataSourceId);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
