import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { EmbeddingProvider } from '../embedding/embeddingProvider';
import { EmbeddingProviderRegistry } from '../embedding/registry';
import { GitHubFetcher } from '../sources/github/githubFetcher';
import { FileFilter } from './fileFilter';
import { Chunker } from './chunker';
import { ChunkStore, ChunkRecord } from '../storage/chunkStore';
import { EmbeddingStore } from '../storage/embeddingStore';
import { SyncStore } from '../storage/syncStore';
import { Logger } from '../util/logger';

const MAX_CONCURRENCY = 3;

export class IngestionPipeline implements vscode.Disposable {
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private readonly chunker: Chunker;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly providerRegistry: EmbeddingProviderRegistry,
    private readonly fetcher: GitHubFetcher,
    private readonly chunkStore: ChunkStore,
    private readonly embeddingStore: EmbeddingStore,
    private readonly syncStore: SyncStore,
    private readonly logger: Logger,
  ) {
    this.chunker = new Chunker();
  }

  enqueue(dataSourceId: string): void {
    if (this.queue.includes(dataSourceId) || this.running.has(dataSourceId)) {
      return;
    }
    this.queue.push(dataSourceId);
    this.configManager.updateDataSource(dataSourceId, { status: 'queued' });
    this.processQueue();
  }

  private processQueue(): void {
    while (this.running.size < MAX_CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.running.add(id);
      this.ingestDataSource(id).finally(() => {
        this.running.delete(id);
        this.processQueue();
      });
    }
  }

  private async ingestDataSource(dataSourceId: string): Promise<void> {
    const ds = this.configManager.getDataSource(dataSourceId);
    if (!ds) return;

    const syncId = crypto.randomUUID();
    let commitSha: string | null = null;

    try {
      this.configManager.updateDataSource(dataSourceId, { status: 'indexing' });
      this.logger.info(`Indexing ${ds.owner}/${ds.repo}@${ds.branch}`);

      // Get current HEAD
      commitSha = await this.fetcher.getBranchSha(ds.owner, ds.repo, ds.branch);
      this.syncStore.startSync(syncId, dataSourceId, commitSha);

      // Fetch file tree
      const tree = await this.fetcher.getTree(ds.owner, ds.repo, commitSha);

      // Filter files
      const filter = new FileFilter(
        ds.includePatterns,
        [...ds.excludePatterns, ...this.configManager.getConfig().defaultExcludePatterns],
      );
      const filteredEntries = tree.filter((entry) => filter.matches(entry.path));

      this.logger.info(`Fetching ${filteredEntries.length} files`);

      // Clear existing data for this source (full re-index)
      this.chunkStore.deleteByDataSource(dataSourceId);

      // Fetch file contents
      const files = await this.fetcher.fetchFiles(ds.owner, ds.repo, filteredEntries);

      // Get embedding provider
      const provider = await this.providerRegistry.getProvider();

      // Chunk all files
      const allChunks: ChunkRecord[] = [];
      for (const file of files) {
        const chunks = this.chunker.chunkFile(file.content, file.path);
        for (const chunk of chunks) {
          allChunks.push({
            id: crypto.randomUUID(),
            dataSourceId,
            filePath: file.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
          });
        }
      }

      // Store chunks
      this.chunkStore.insertMany(allChunks);

      // Embed in batches
      await this.embedChunks(allChunks, provider);

      // Update state
      this.configManager.updateDataSource(dataSourceId, {
        status: 'ready',
        lastSyncedAt: new Date().toISOString(),
        lastSyncCommitSha: commitSha,
      });
      this.syncStore.completeSync(syncId, files.length, allChunks.length);
      this.logger.info(`Indexed ${allChunks.length} chunks from ${files.length} files`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.configManager.updateDataSource(dataSourceId, {
        status: 'error',
        errorMessage: message,
      });
      this.syncStore.failSync(syncId, message);
      this.logger.error(`Indexing failed for ${ds.owner}/${ds.repo}: ${message}`);
    }
  }

  private async embedChunks(
    chunks: ChunkRecord[],
    provider: EmbeddingProvider,
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
    }
  }

  async removeDataSource(dataSourceId: string): Promise<void> {
    const chunks = this.chunkStore.getByDataSource(dataSourceId);
    const chunkIds = chunks.map((c) => c.id);
    this.embeddingStore.deleteByChunkIds(chunkIds);
    this.chunkStore.deleteByDataSource(dataSourceId);
  }

  dispose(): void {
    this.queue.length = 0;
  }
}
