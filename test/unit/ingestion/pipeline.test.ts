import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { pack as tarPack } from 'tar-stream';
import Database from 'better-sqlite3';
import { openDatabase } from '../../../src/storage/database';
import { ChunkStore } from '../../../src/storage/chunkStore';
import { EmbeddingStore } from '../../../src/storage/embeddingStore';
import { SyncStore } from '../../../src/storage/syncStore';
import { DataSourceStore } from '../../../src/storage/dataSourceStore';
import { IndexingRunStore } from '../../../src/storage/indexingRunStore';
import { GitHubFetcher } from '../../../src/sources/github/githubFetcher';
import {
  IngestionPipeline,
  PipelineConfigSource,
  PipelineEmbeddingSource,
  PipelineLogger,
} from '../../../src/ingestion/pipeline';
import { DataSourceConfig } from '../../../src/config/configSchema';
import { EmbeddingProvider } from '../../../src/embedding/embeddingProvider';

// --- Test fixtures ---

async function buildTarGz(entries: Array<{ name: string; content: string }>): Promise<Buffer> {
  const p = tarPack();
  for (const e of entries) p.entry({ name: e.name }, e.content);
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of p) chunks.push(chunk as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

const TEST_DIMS = 4;

function makeDataSource(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: 'ds-1',
    repoUrl: 'https://github.com/test/repo',
    owner: 'test',
    repo: 'repo',
    branch: 'main',
    includePatterns: [],
    excludePatterns: [],
    syncSchedule: 'manual',
    lastSyncedAt: null,
    lastSyncCommitSha: null,
    status: 'queued',
    ...overrides,
  };
}

function makeMockProvider(): EmbeddingProvider {
  return {
    id: 'test',
    maxBatchSize: 100,
    maxInputTokens: 8000,
    dimensions: TEST_DIMS,
    embed: vi.fn().mockImplementation(async (texts: string[]) => {
      // Return a deterministic vector based on text length
      return texts.map((t) => {
        const val = t.length / 100;
        return [val, val, val, val];
      });
    }),
    countTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

function makeMockLogger(): PipelineLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// --- Tests ---

describe('IngestionPipeline', () => {
  let db: Database.Database;
  let chunkStore: ChunkStore;
  let embeddingStore: EmbeddingStore;
  let syncStore: SyncStore;
  let dsStore: DataSourceStore;
  let indexingRunStore: IndexingRunStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    db = openDatabase({ dimensions: TEST_DIMS });
    chunkStore = new ChunkStore(db);
    embeddingStore = new EmbeddingStore(db);
    syncStore = new SyncStore(db);
    dsStore = new DataSourceStore(db);
    indexingRunStore = new IndexingRunStore(db);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  function makePipeline(
    dataSources: DataSourceConfig[],
    provider?: EmbeddingProvider,
    deltaSync?: any,
  ) {
    const dsMap = new Map(dataSources.map((ds) => [ds.id, { ...ds }]));

    // Insert into DB for FK constraints
    for (const ds of dataSources) {
      dsStore.insert(ds.id, ds.owner, ds.repo, ds.branch, ds.status);
    }

    const config: PipelineConfigSource = {
      getDataSource: (id) => dsMap.get(id),
      getDefaultExcludePatterns: () => ['**/node_modules/**'],
      updateDataSource: (id, updates) => {
        const ds = dsMap.get(id);
        if (ds) Object.assign(ds, updates);
      },
    };

    const embeddingSource: PipelineEmbeddingSource = {
      getProvider: async () => provider ?? makeMockProvider(),
    };

    const logger = makeMockLogger();
    const fetcher = new GitHubFetcher(async () => 'test-token');

    return {
      pipeline: new IngestionPipeline(
        config,
        embeddingSource,
        fetcher,
        chunkStore,
        embeddingStore,
        syncStore,
        indexingRunStore,
        logger,
        deltaSync,
      ),
      config,
      logger,
      dsMap,
    };
  }

  function mockGitHubApi(files: Array<{ path: string; content: string }>) {
    // Build the tarball once, synchronously keyed on files content
    let tarballBuf: Buffer | null = null;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      const headers = new Headers({
        'X-RateLimit-Remaining': '4999',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
      });

      // Branch SHA
      if (urlStr.includes('/branches/')) {
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          json: async () => ({ commit: { sha: 'abc123' } }),
        };
      }

      // Tree
      if (urlStr.includes('/git/trees/')) {
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          json: async () => ({
            tree: files.map((f, i) => ({
              path: f.path,
              sha: `blob-sha-${i}`,
              size: f.content.length,
              type: 'blob',
            })),
            truncated: false,
          }),
        };
      }

      // Tarball — full ingest fetches the whole repo as a tar.gz
      if (urlStr.includes('/tarball/')) {
        if (!tarballBuf) {
          tarballBuf = await buildTarGz(
            files.map((f) => ({ name: `test-repo-abc123/${f.path}`, content: f.content })),
          );
        }
        const buf = tarballBuf;
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(buf));
              controller.close();
            },
          }),
        };
      }

      // Blob — delta sync fetches individual files via the blob API
      if (urlStr.includes('/git/blobs/')) {
        const sha = urlStr.split('/blobs/')[1];
        const idx = parseInt(sha.replace('blob-sha-', ''), 10);
        const content = isNaN(idx) ? '' : (files[idx]?.content ?? '');
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          text: async () => content,
        };
      }

      return { ok: false, status: 404, statusText: 'Not Found', headers, text: async () => 'not found' };
    });
  }

  it('ingests files end-to-end: fetch → filter → chunk → embed → store', async () => {
    const ds = makeDataSource();
    const files = [
      { path: 'src/index.ts', content: 'const hello = "world";\nexport default hello;' },
      { path: 'src/util.ts', content: 'export function add(a: number, b: number) {\n  return a + b;\n}' },
    ];

    mockGitHubApi(files);
    const { pipeline, dsMap } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    // Chunks were created
    const chunks = chunkStore.getByDataSource('ds-1');
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Embeddings were created (one per chunk)
    const results = embeddingStore.searchAll(
      [0.1, 0.1, 0.1, 0.1],
      100,
    );
    expect(results.length).toBe(chunks.length);

    // Sync history was recorded
    const sync = syncStore.getLatest('ds-1');
    expect(sync).toBeDefined();
    expect(sync!.status).toBe('completed');
    expect(sync!.filesProcessed).toBe(2);
    expect(sync!.filesTotal).toBe(2);
    expect(sync!.chunksCreated).toBe(chunks.length);

    // Data source status updated
    const updatedDs = dsMap.get('ds-1')!;
    expect(updatedDs.status).toBe('ready');
    expect(updatedDs.lastSyncCommitSha).toBe('abc123');
  });

  it('applies file filters (include patterns)', async () => {
    const ds = makeDataSource({ includePatterns: ['**/*.ts'] });
    const files = [
      { path: 'src/index.ts', content: 'typescript code' },
      { path: 'src/style.css', content: 'body { color: red; }' },
      { path: 'docs/readme.md', content: '# README' },
    ];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    const chunks = chunkStore.getByDataSource('ds-1');
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    expect(filePaths).toEqual(['src/index.ts']);
  });

  it('applies default exclude patterns', async () => {
    const ds = makeDataSource();
    const files = [
      { path: 'src/index.ts', content: 'good code' },
      { path: 'node_modules/lodash/index.js', content: 'excluded' },
    ];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    const chunks = chunkStore.getByDataSource('ds-1');
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    expect(filePaths).toEqual(['src/index.ts']);
  });

  it('removes stale files after a successful re-index', async () => {
    const ds = makeDataSource();
    const files = [{ path: 'a.ts', content: 'first version' }];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    // First ingestion
    await pipeline.ingestDataSource('ds-1');
    expect(chunkStore.countByDataSource('ds-1')).toBeGreaterThan(0);

    // Re-index with different content
    const files2 = [{ path: 'b.ts', content: 'second version with more content' }];
    mockGitHubApi(files2);

    await pipeline.ingestDataSource('ds-1');

    const chunks = chunkStore.getByDataSource('ds-1');
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    // Old file should be gone, only new file present
    expect(filePaths).toEqual(['b.ts']);
  });

  it('sets error status on failure', async () => {
    const ds = makeDataSource();

    // Mock API that fails
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { pipeline, dsMap, logger } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    expect(dsMap.get('ds-1')!.status).toBe('error');
    expect(dsMap.get('ds-1')!.errorMessage).toContain('GitHub branch lookup failed');
    expect(dsMap.get('ds-1')!.errorMessage).toContain('Network error');
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('records stage-aware embedding transport failures while keeping partial chunks', async () => {
    const ds = makeDataSource();
    const files = [{ path: 'a.ts', content: 'export const a = 1;\n' }];
    mockGitHubApi(files);

    const provider = makeMockProvider();
    provider.embed = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const { pipeline, dsMap } = makePipeline([ds], provider);
    await pipeline.ingestDataSource('ds-1');

    expect(dsMap.get('ds-1')!.status).toBe('error');
    expect(dsMap.get('ds-1')!.errorMessage).toContain('Embedding batch failed');
    expect(dsMap.get('ds-1')!.errorMessage).toContain('last file a.ts');
    expect(chunkStore.getDataSourceStats('ds-1').fileCount).toBe(1);
  });

  it('removeDataSource clears chunks and embeddings', async () => {
    const ds = makeDataSource();
    const files = [{ path: 'a.ts', content: 'some code here' }];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');
    expect(chunkStore.countByDataSource('ds-1')).toBeGreaterThan(0);

    await pipeline.removeDataSource('ds-1');

    expect(chunkStore.countByDataSource('ds-1')).toBe(0);
    const results = embeddingStore.searchAll([0.1, 0.1, 0.1, 0.1], 100);
    expect(results).toHaveLength(0);
  });

  it('deduplicates enqueue calls', () => {
    const ds = makeDataSource();
    // Never-resolving fetch so the pipeline stays in "running" state
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { pipeline } = makePipeline([ds]);

    pipeline.enqueue('ds-1');
    pipeline.enqueue('ds-1'); // duplicate
    pipeline.enqueue('ds-1'); // duplicate

    // Should only have 0 in queue (1 is running)
    expect(pipeline.runningCount).toBe(1);
    expect(pipeline.queueSize).toBe(0);

    pipeline.dispose();
  });

  it('respects concurrency limit', async () => {
    // Use a separate in-memory DB for this test so we can leave it open
    // while hanging promises settle after the test.
    const testDb = openDatabase({ dimensions: TEST_DIMS });
    const testChunkStore = new ChunkStore(testDb);
    const testEmbeddingStore = new EmbeddingStore(testDb);
    const testSyncStore = new SyncStore(testDb);
    const testDsStore = new DataSourceStore(testDb);

    // Fetch that never resolves — we just want to inspect queue state
    globalThis.fetch = vi.fn().mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const dataSources = Array.from({ length: 5 }, (_, i) =>
      makeDataSource({ id: `ds-${i}`, owner: 'test', repo: `repo-${i}` }),
    );

    for (const ds of dataSources) {
      testDsStore.insert(ds.id, ds.owner, ds.repo, ds.branch, ds.status);
    }

    const dsMap = new Map(dataSources.map((ds) => [ds.id, { ...ds }]));
    const config: PipelineConfigSource = {
      getDataSource: (id) => dsMap.get(id),
      getDefaultExcludePatterns: () => [],
      updateDataSource: (id, updates) => {
        const d = dsMap.get(id);
        if (d) Object.assign(d, updates);
      },
    };
    const embeddingSource: PipelineEmbeddingSource = {
      getProvider: async () => makeMockProvider(),
    };

    const pipeline = new IngestionPipeline(
      config,
      embeddingSource,
      new GitHubFetcher(async () => 'token'),
      testChunkStore,
      testEmbeddingStore,
      testSyncStore,
      new IndexingRunStore(testDb),
      makeMockLogger(),
    );

    for (const ds of dataSources) {
      pipeline.enqueue(ds.id);
    }

    // 3 running (blocked on fetch), 2 queued
    expect(pipeline.runningCount).toBe(3);
    expect(pipeline.queueSize).toBe(2);

    // Dispose clears the queue. The 3 running promises hang forever
    // (never-resolving fetch) but that's fine — they'll be GC'd.
    pipeline.dispose();
    // Don't close testDb — the hanging promises may reference it.
    // In-memory DBs are cleaned up on GC.
  });

  it('uses delta sync when lastSyncCommitSha is set', async () => {
    const ds = makeDataSource({ lastSyncCommitSha: 'old-sha' });
    const files = [{ path: 'a.ts', content: 'original content' }];
    mockGitHubApi(files);

    const mockDeltaSync = {
      computeDelta: vi.fn().mockResolvedValue({
        added: [{ path: 'new.ts', sha: 'blob-sha-0', size: 10, type: 'blob' }],
        modified: [],
        deleted: [],
        unchanged: ['a.ts'],
        newCommitSha: 'abc123',
      }),
    };

    const { pipeline, dsMap } = makePipeline([ds], undefined, mockDeltaSync);

    // First do a full index so there's existing data
    await pipeline.ingestDataSource('ds-1');
    const countAfterFull = chunkStore.countByDataSource('ds-1');
    expect(countAfterFull).toBeGreaterThan(0);

    // Now set lastSyncCommitSha and re-ingest — should use delta
    dsMap.get('ds-1')!.lastSyncCommitSha = 'old-sha';
    await pipeline.ingestDataSource('ds-1');

    expect(mockDeltaSync.computeDelta).toHaveBeenCalledWith(
      'test', 'repo', 'old-sha', 'abc123',
    );
    expect(dsMap.get('ds-1')!.status).toBe('ready');
  });

  it('falls back to full reindex when delta sync fails', async () => {
    const ds = makeDataSource({ lastSyncCommitSha: 'old-sha' });
    const files = [{ path: 'a.ts', content: 'content' }];
    mockGitHubApi(files);

    const mockDeltaSync = {
      computeDelta: vi.fn().mockRejectedValue(new Error('compare failed')),
    };

    const { pipeline, dsMap, logger } = makePipeline([ds], undefined, mockDeltaSync);
    await pipeline.ingestDataSource('ds-1');

    // Should still succeed via full reindex
    expect(dsMap.get('ds-1')!.status).toBe('ready');
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c: string[]) => c[0].includes('falling back'),
    )).toBe(true);
  });

  it('delta sync removes chunks for deleted files', async () => {
    const ds = makeDataSource();
    const files = [
      { path: 'a.ts', content: 'file a content' },
      { path: 'b.ts', content: 'file b content' },
    ];
    mockGitHubApi(files);

    const mockDeltaSync = {
      computeDelta: vi.fn().mockResolvedValue({
        added: [],
        modified: [],
        deleted: ['a.ts'],
        unchanged: ['b.ts'],
        newCommitSha: 'abc123',
      }),
    };

    const { pipeline, dsMap } = makePipeline([ds], undefined, mockDeltaSync);

    // Full index first
    await pipeline.ingestDataSource('ds-1');
    const chunksBeforeDelta = chunkStore.getByDataSource('ds-1');
    const aChunks = chunksBeforeDelta.filter((c) => c.filePath === 'a.ts');
    expect(aChunks.length).toBeGreaterThan(0);

    // Delta sync — delete a.ts
    dsMap.get('ds-1')!.lastSyncCommitSha = 'prev-sha';
    await pipeline.ingestDataSource('ds-1');

    const chunksAfterDelta = chunkStore.getByDataSource('ds-1');
    const aChunksAfter = chunksAfterDelta.filter((c) => c.filePath === 'a.ts');
    expect(aChunksAfter).toHaveLength(0);
    // b.ts should still exist
    const bChunksAfter = chunksAfterDelta.filter((c) => c.filePath === 'b.ts');
    expect(bChunksAfter.length).toBeGreaterThan(0);
  });

  it('reports progress during ingestion', async () => {
    const ds = makeDataSource();
    const files = [{ path: 'a.ts', content: 'hello world' }];
    mockGitHubApi(files);

    const { pipeline } = makePipeline([ds]);
    const progress = { report: vi.fn() };

    await pipeline.ingestDataSource('ds-1', progress);

    expect(progress.report).toHaveBeenCalled();
    const messages = progress.report.mock.calls.map((c: any) => c[0]);
    expect(messages.some((m: string) => m.includes('Fetching'))).toBe(true);
  });

  it('resumes a partial run and only processes remaining files', async () => {
    const ds = makeDataSource();
    const files = [
      { path: 'a.ts', content: 'export const a = 1;\n' },
      { path: 'b.ts', content: 'export const b = 2;\n' },
    ];

    let tarballCalls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      const headers = new Headers({
        'X-RateLimit-Remaining': '4999',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
      });

      if (urlStr.includes('/branches/')) {
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          json: async () => ({ commit: { sha: 'abc123' } }),
        };
      }
      if (urlStr.includes('/git/trees/')) {
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          json: async () => ({
            tree: files.map((f, i) => ({
              path: f.path,
              sha: `blob-sha-${i}`,
              size: f.content.length,
              type: 'blob',
            })),
            truncated: false,
          }),
        };
      }
      if (urlStr.includes('/tarball/')) {
        tarballCalls += 1;
        const tarEntries = tarballCalls <= 2
          ? [{ name: 'test-repo-abc123/a.ts', content: files[0].content }]
          : [{ name: 'test-repo-abc123/b.ts', content: files[1].content }];
        const tarball = await buildTarGz(tarEntries);
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(tarball));
              controller.close();
            },
          }),
        };
      }
      return { ok: false, status: 404, statusText: 'Not Found', headers, text: async () => 'not found' };
    });

    const { pipeline, dsMap } = makePipeline([ds]);
    await pipeline.ingestDataSource('ds-1');
    expect(dsMap.get('ds-1')!.status).toBe('error');
    expect(chunkStore.getDataSourceStats('ds-1').fileCount).toBe(1);

    await pipeline.ingestDataSource('ds-1');
    expect(dsMap.get('ds-1')!.status).toBe('ready');
    expect(chunkStore.getDataSourceStats('ds-1').fileCount).toBe(2);
  });

  it('falls back to blob fetch when tarball streaming fails mid-run', async () => {
    const ds = makeDataSource();
    const files = [
      { path: 'a.ts', content: 'export const a = 1;\n' },
      { path: 'b.ts', content: 'export const b = 2;\n' },
    ];

    let tarballCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      const headers = new Headers({
        'X-RateLimit-Remaining': '4999',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
      });

      if (urlStr.includes('/branches/')) {
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          json: async () => ({ commit: { sha: 'abc123' } }),
        };
      }
      if (urlStr.includes('/git/trees/')) {
        return {
          ok: true, status: 200, statusText: 'OK', headers,
          json: async () => ({
            tree: files.map((f, i) => ({
              path: f.path,
              sha: `blob-sha-${i}`,
              size: f.content.length,
              type: 'blob',
            })),
            truncated: false,
          }),
        };
      }
      if (urlStr.includes('/tarball/')) {
        tarballCallCount += 1;
        if (tarballCallCount <= 2) {
          throw new Error('fetch failed');
        }
      }
      if (urlStr.includes('/git/blobs/')) {
        const sha = urlStr.split('/blobs/')[1];
        const idx = parseInt(sha.replace('blob-sha-', ''), 10);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers,
          text: async () => files[idx].content,
        };
      }
      return { ok: false, status: 404, statusText: 'Not Found', headers, text: async () => 'not found' };
    });

    const { pipeline, dsMap } = makePipeline([ds]);
    await pipeline.ingestDataSource('ds-1');

    const sync = syncStore.getLatest('ds-1');
    expect(dsMap.get('ds-1')!.status).toBe('ready');
    expect(sync!.fetchStrategy).toBe('tarball+blob-fallback');
    expect(chunkStore.getDataSourceStats('ds-1').fileCount).toBe(2);
  });
});
