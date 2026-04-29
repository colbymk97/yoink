import { describe, it, expect, vi } from 'vitest';

// Mock vscode before any imports that use it
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultVal: any) => defaultVal,
    }),
  },
  LanguageModelToolResult: class {
    constructor(public parts: any[]) {}
  },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
}));

import { ToolHandler } from '../../../src/tools/toolHandler';
import { EmbeddingProvider } from '../../../src/embedding/embeddingProvider';
import { DataSourceConfig } from '../../../src/config/configSchema';

// --- Helpers ---

function makeProvider(): EmbeddingProvider {
  return {
    id: 'test',
    maxBatchSize: 100,
    maxInputTokens: 8000,
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    countTokens: (t: string) => Math.ceil(t.length / 4),
  };
}

function makeDs(id: string, status: string = 'ready'): DataSourceConfig {
  return {
    id,
    repoUrl: `https://github.com/test/${id}`,
    owner: 'test',
    repo: id,
    branch: 'main',
    includePatterns: [],
    excludePatterns: [],
    syncSchedule: 'manual',
    lastSyncedAt: null,
    lastSyncCommitSha: null,
    status: status as any,
  };
}

function makeHandler(
  dataSources: DataSourceConfig[],
  searchResults: any[] = [],
  chunkCounts: Record<string, number> = {},
  fileContents: Record<string, string | Error> = {},
  fileStats: any[] = [],
  chunks: any[] = [],
) {
  const dsMap = new Map(dataSources.map((ds) => [ds.id, ds]));

  const configManager = {
    getDataSources: () => dataSources,
    getDataSource: (id: string) => dsMap.get(id),
  } as any;

  const provider = makeProvider();
  const providerRegistry = {
    getProvider: vi.fn().mockResolvedValue(provider),
  } as any;

  const retriever = {
    search: vi.fn().mockResolvedValue(searchResults),
  } as any;

  const chunkStore = {
    getDataSourceStats: vi.fn().mockReturnValue({
      fileCount: 10,
      chunkCount: 50,
      totalTokens: 12000,
    }),
    countByDataSource: vi.fn().mockImplementation((id: string) => chunkCounts[id] ?? 0),
    getFileStats: vi.fn().mockReturnValue(fileStats),
    getByDataSource: vi.fn().mockReturnValue(chunks),
  } as any;

  const fetcher = {
    getFileContents: vi.fn().mockImplementation(
      (_owner: string, _repo: string, filePath: string) => {
        const value = fileContents[filePath];
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? '');
      },
    ),
  } as any;

  const handler = new ToolHandler(
    configManager,
    providerRegistry,
    retriever,
    chunkStore,
    fetcher,
  );
  return { handler, retriever, providerRegistry, chunkStore, fetcher };
}

const dummyToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

function makeFileStats(filePath: string, tokenCount = 100) {
  return { filePath, chunkCount: 1, tokenCount };
}

function makeChunk(filePath: string, content: string, dataSourceId = 'repo') {
  return {
    id: `chunk-${filePath}`,
    dataSourceId,
    filePath,
    startLine: 1,
    endLine: content.split('\n').length,
    content,
    tokenCount: Math.ceil(content.length / 4),
  };
}

describe('ToolHandler', () => {
  describe('handleGlobalSearch', () => {
    it('searches all ready data sources', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const ds2 = makeDs('ds-2', 'indexing');
      const { handler, retriever } = makeHandler([ds1, ds2]);

      await handler.handleGlobalSearch(
        { input: { query: 'test query' } } as any,
        dummyToken as any,
      );

      expect(retriever.search).toHaveBeenCalledWith(
        'test query',
        ['ds-1'],
        expect.anything(),
        10,
      );
    });

    it('includes partial data sources when they already have chunks', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const ds2 = makeDs('ds-2', 'indexing');
      const { handler, retriever } = makeHandler([ds1, ds2], [], { 'ds-2': 3 });

      await handler.handleGlobalSearch(
        { input: { query: 'test query' } } as any,
        dummyToken as any,
      );

      expect(retriever.search).toHaveBeenCalledWith(
        'test query',
        ['ds-1', 'ds-2'],
        expect.anything(),
        10,
      );
    });

    it('excludes deleting data sources even when they have chunks', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const ds2 = makeDs('ds-2', 'deleting');
      const { handler, retriever } = makeHandler([ds1, ds2], [], { 'ds-2': 3 });

      await handler.handleGlobalSearch(
        { input: { query: 'test query' } } as any,
        dummyToken as any,
      );

      expect(retriever.search).toHaveBeenCalledWith(
        'test query',
        ['ds-1'],
        expect.anything(),
        10,
      );
    });

    it('filters by repository parameter', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const ds2 = makeDs('ds-2', 'ready');
      const { handler, retriever } = makeHandler([ds1, ds2]);

      await handler.handleGlobalSearch(
        { input: { query: 'test', repository: 'test/ds-1' } } as any,
        dummyToken as any,
      );

      expect(retriever.search).toHaveBeenCalledWith(
        'test',
        ['ds-1'],
        expect.anything(),
        10,
      );
    });

    it('returns error when no repositories indexed', async () => {
      const { handler } = makeHandler([]);

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('No repositories are indexed');
    });

    it('returns error message when search fails', async () => {
      const ds1 = makeDs('ds-1');
      const { handler, retriever } = makeHandler([ds1]);
      retriever.search.mockRejectedValue(new Error('embedding failed'));

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('Search failed');
      expect(result.parts[0].value).toContain('embedding failed');
    });

    it('returns structured inline JSON results', async () => {
      const ds1 = makeDs('ds-1');
      const mockResults = [
        {
          chunk: {
            id: 'c1',
            dataSourceId: 'ds-1',
            filePath: 'src/index.ts',
            startLine: 3,
            endLine: 8,
            content: 'export function test() { return 1; }',
          },
          distance: -0.15,
        },
      ];
      const { handler } = makeHandler([ds1], mockResults);

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test' } } as any,
        dummyToken as any,
      );

      const payload = JSON.parse(result.parts[0].value);
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]).toMatchObject({
        id: 'c1',
        repository: 'test/ds-1',
        filePath: 'src/index.ts',
        startLine: 3,
        endLine: 8,
        resultType: 'code',
      });
      expect(payload.hasMore).toBe(false);
      expect(payload.nextCursor).toBeNull();
    });

    it('supports cursor pagination with deterministic ordering', async () => {
      const ds1 = makeDs('ds-1');
      const mockResults = [
        {
          chunk: {
            id: 'b',
            dataSourceId: 'ds-1',
            filePath: 'src/z.ts',
            startLine: 1,
            endLine: 1,
            content: 'z',
          },
          distance: -0.2,
        },
        {
          chunk: {
            id: 'a',
            dataSourceId: 'ds-1',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 1,
            content: 'a',
          },
          distance: -0.2,
        },
      ];
      const { handler } = makeHandler([ds1], mockResults);
      const first = await handler.handleGlobalSearch(
        { input: { query: 'test', pageSize: 1 } } as any,
        dummyToken as any,
      );
      const firstPayload = JSON.parse(first.parts[0].value);
      expect(firstPayload.hasMore).toBe(true);
      expect(firstPayload.results[0].id).toBe('a');
      expect(typeof firstPayload.nextCursor).toBe('string');

      const second = await handler.handleGlobalSearch(
        { input: { query: 'test', pageSize: 1, cursor: firstPayload.nextCursor } } as any,
        dummyToken as any,
      );
      const secondPayload = JSON.parse(second.parts[0].value);
      expect(secondPayload.results[0].id).toBe('b');
    });

    it('returns a file-diverse first page before duplicate chunks', async () => {
      const ds1 = makeDs('ds-1');
      const mockResults = [
        {
          chunk: {
            id: 'a-1',
            dataSourceId: 'ds-1',
            filePath: 'src/auth/sessionManager.ts',
            startLine: 1,
            endLine: 12,
            content: 'session primary',
          },
          distance: -0.1,
        },
        {
          chunk: {
            id: 'a-2',
            dataSourceId: 'ds-1',
            filePath: 'src/auth/sessionManager.ts',
            startLine: 13,
            endLine: 24,
            content: 'session duplicate',
          },
          distance: -0.11,
        },
        {
          chunk: {
            id: 'b-1',
            dataSourceId: 'ds-1',
            filePath: 'src/security/tokenVerifier.ts',
            startLine: 1,
            endLine: 8,
            content: 'token verifier',
          },
          distance: -0.12,
        },
        {
          chunk: {
            id: 'c-1',
            dataSourceId: 'ds-1',
            filePath: 'docs/authentication-guide.md',
            startLine: 1,
            endLine: 8,
            content: 'auth guide',
          },
          distance: -0.13,
        },
      ];
      const { handler } = makeHandler([ds1], mockResults);

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test', pageSize: 3 } } as any,
        dummyToken as any,
      );

      const payload = JSON.parse(result.parts[0].value);
      expect(payload.results.map((entry: any) => entry.id)).toEqual(['a-1', 'b-1', 'c-1']);
      expect(payload.hasMore).toBe(true);
    });

    it('continues pagination through deferred duplicate chunks deterministically', async () => {
      const ds1 = makeDs('ds-1');
      const mockResults = [
        {
          chunk: {
            id: 'a-1',
            dataSourceId: 'ds-1',
            filePath: 'src/auth/sessionManager.ts',
            startLine: 1,
            endLine: 12,
            content: 'session primary',
          },
          distance: -0.1,
        },
        {
          chunk: {
            id: 'a-2',
            dataSourceId: 'ds-1',
            filePath: 'src/auth/sessionManager.ts',
            startLine: 13,
            endLine: 24,
            content: 'session duplicate',
          },
          distance: -0.11,
        },
        {
          chunk: {
            id: 'b-1',
            dataSourceId: 'ds-1',
            filePath: 'src/security/tokenVerifier.ts',
            startLine: 1,
            endLine: 8,
            content: 'token verifier',
          },
          distance: -0.12,
        },
        {
          chunk: {
            id: 'c-1',
            dataSourceId: 'ds-1',
            filePath: 'docs/authentication-guide.md',
            startLine: 1,
            endLine: 8,
            content: 'auth guide',
          },
          distance: -0.13,
        },
      ];
      const { handler } = makeHandler([ds1], mockResults);

      const first = await handler.handleGlobalSearch(
        { input: { query: 'test', pageSize: 2 } } as any,
        dummyToken as any,
      );
      const firstPayload = JSON.parse(first.parts[0].value);

      const second = await handler.handleGlobalSearch(
        { input: { query: 'test', pageSize: 2, cursor: firstPayload.nextCursor } } as any,
        dummyToken as any,
      );
      const secondPayload = JSON.parse(second.parts[0].value);

      expect(firstPayload.results.map((entry: any) => entry.id)).toEqual(['a-1', 'b-1']);
      expect(secondPayload.results.map((entry: any) => entry.id)).toEqual(['c-1', 'a-2']);
    });
  });

  describe('handleList', () => {
    it('returns data source info with stats for ready sources', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const { handler, chunkStore } = makeHandler([ds1]);

      const result = await handler.handleList(dummyToken as any);

      expect(chunkStore.getDataSourceStats).toHaveBeenCalledWith('ds-1');
      expect(result.parts[0].value).toContain('test/ds-1@main');
      expect(result.parts[0].value).toContain('ready');
      expect(result.parts[0].value).toContain('10 files');
      expect(result.parts[0].value).toContain('50 chunks');
    });

    it('skips stats for non-ready sources', async () => {
      const ds1 = makeDs('ds-1', 'indexing');
      const { handler, chunkStore } = makeHandler([ds1]);

      const result = await handler.handleList(dummyToken as any);

      expect(chunkStore.getDataSourceStats).not.toHaveBeenCalled();
      expect(result.parts[0].value).toContain('indexing');
    });

    it('shows partial stats for searchable non-ready sources', async () => {
      const ds1 = makeDs('ds-1', 'error');
      const { handler, chunkStore } = makeHandler([ds1], [], { 'ds-1': 4 });

      const result = await handler.handleList(dummyToken as any);

      expect(chunkStore.getDataSourceStats).toHaveBeenCalledWith('ds-1');
      expect(result.parts[0].value).toContain('[partial]');
      expect(result.parts[0].value).toContain('50 chunks');
    });

    it('lists deleting sources without searchable partial stats', async () => {
      const ds1 = makeDs('ds-1', 'deleting');
      const { handler, chunkStore } = makeHandler([ds1], [], { 'ds-1': 4 });

      const result = await handler.handleList(dummyToken as any);

      expect(chunkStore.getDataSourceStats).not.toHaveBeenCalled();
      expect(result.parts[0].value).toContain('test/ds-1@main');
      expect(result.parts[0].value).toContain('deleting');
      expect(result.parts[0].value).not.toContain('[partial]');
    });

    it('returns no data sources message when empty', async () => {
      const { handler } = makeHandler([]);

      const result = await handler.handleList(dummyToken as any);

      expect(result.parts[0].value).toContain('No data sources configured');
    });
  });

  describe('handleGetFiles', () => {
    it('requires at least one file', async () => {
      const { handler, fetcher } = makeHandler([makeDs('repo')]);

      const result = await handler.handleGetFiles({ input: { files: [] } } as any, dummyToken as any);

      expect(result.parts[0].value).toContain('Provide at least one file');
      expect(fetcher.getFileContents).not.toHaveBeenCalled();
    });

    it('rejects requests above the per-call file limit before fetching', async () => {
      const { handler, fetcher } = makeHandler([makeDs('repo')]);
      const files = Array.from({ length: 11 }, (_, i) => ({
        repository: 'test/repo',
        filePath: `src/file-${i}.ts`,
      }));

      const result = await handler.handleGetFiles({ input: { files } } as any, dummyToken as any);

      expect(result.parts[0].value).toContain('Too many files requested (11)');
      expect(fetcher.getFileContents).not.toHaveBeenCalled();
    });

    it('fetches from the configured branch and returns a requested line range', async () => {
      const ds = makeDs('repo');
      ds.branch = 'release';
      const { handler, fetcher } = makeHandler(
        [ds],
        [],
        {},
        { 'src/app.ts': ['one', 'two', 'three', 'four'].join('\n') },
      );

      const result = await handler.handleGetFiles(
        {
          input: {
            files: [{
              repository: 'TEST/REPO',
              filePath: 'src/app.ts',
              startLine: 2,
              endLine: 3,
            }],
          },
        } as any,
        dummyToken as any,
      );

      expect(fetcher.getFileContents).toHaveBeenCalledWith('test', 'repo', 'src/app.ts', 'release');
      expect(result.parts[0].value).toContain('lines 2–3 of 4');
      expect(result.parts[0].value).toContain('two\nthree');
      expect(result.parts[0].value).not.toContain('one');
      expect(result.parts[0].value).not.toContain('four');
    });

    it('reports mixed per-file failures without failing the whole request', async () => {
      const { handler } = makeHandler(
        [makeDs('repo')],
        [],
        {},
        {
          'src/good.ts': 'export const ok = true;',
          'src/missing.ts': new Error('Not Found'),
        },
      );

      const result = await handler.handleGetFiles(
        {
          input: {
            files: [
              { repository: 'test/repo', filePath: 'src/good.ts' },
              { repository: 'test/repo', filePath: 'assets/logo.png' },
              { repository: 'test/unknown', filePath: 'src/other.ts' },
              { repository: 'test/repo', filePath: 'src/missing.ts' },
            ],
          },
        } as any,
        dummyToken as any,
      );

      const text = result.parts[0].value;
      expect(text).toContain('1/4 files fetched');
      expect(text).toContain('export const ok = true;');
      expect(text).toContain('Skipped: binary file (.png)');
      expect(text).toContain('Error: repository not indexed. Available: test/repo');
      expect(text).toContain('Error: Not Found');
    });

    it('rejects oversized files with a range hint', async () => {
      const { handler } = makeHandler(
        [makeDs('repo')],
        [],
        {},
        { 'src/huge.ts': 'x'.repeat(500_001) },
      );

      const result = await handler.handleGetFiles(
        { input: { files: [{ repository: 'test/repo', filePath: 'src/huge.ts' }] } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('Error: file too large');
      expect(result.parts[0].value).toContain('Use startLine/endLine');
    });
  });

  describe('handleListWorkflows', () => {
    it('lists workflow files with names and block triggers', async () => {
      const workflow = [
        'name: CI',
        'on:',
        '  push:',
        '  pull_request:',
        'jobs:',
        '  test:',
      ].join('\n');
      const { handler, chunkStore } = makeHandler(
        [makeDs('repo')],
        [],
        {},
        {},
        [
          makeFileStats('.github/workflows/ci.yml'),
          makeFileStats('.github/workflows/readme.md'),
          makeFileStats('deploy.yaml'),
        ],
        [makeChunk('.github/workflows/ci.yml', workflow)],
      );

      const result = await handler.handleListWorkflows(
        { input: { repository: 'test/repo' } } as any,
        dummyToken as any,
      );

      const text = result.parts[0].value;
      expect(chunkStore.getFileStats).toHaveBeenCalledWith('repo');
      expect(text).toContain('## test/repo');
      expect(text).toContain('`.github/workflows/ci.yml`');
      expect(text).toContain('**CI**');
      expect(text).toContain('`push`');
      expect(text).toContain('`pull_request`');
      expect(text).not.toContain('readme.md');
      expect(text).not.toContain('deploy.yaml');
    });

    it('reports when no workflow files are indexed', async () => {
      const { handler } = makeHandler(
        [makeDs('repo')],
        [],
        {},
        {},
        [makeFileStats('src/index.ts')],
      );

      const result = await handler.handleListWorkflows(
        { input: { repository: 'repo' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('No workflow files found');
    });
  });

  describe('handleListActions', () => {
    it('lists action metadata and required inputs', async () => {
      const action = [
        'name: "Setup Widget"',
        'description: "Configures widgets"',
        'inputs:',
        '  token:',
        '    required: true',
        '  cache-key:',
        '    required: false',
      ].join('\n');
      const { handler, chunkStore } = makeHandler(
        [makeDs('repo')],
        [],
        {},
        {},
        [
          makeFileStats('action.yml'),
          makeFileStats('tools/build/action.yaml'),
          makeFileStats('.github/workflows/ci.yml'),
        ],
        [
          makeChunk('action.yml', action),
          makeChunk('tools/build/action.yaml', 'name: Build Action'),
        ],
      );

      const result = await handler.handleListActions(
        { input: { repository: 'test/repo' } } as any,
        dummyToken as any,
      );

      const text = result.parts[0].value;
      expect(chunkStore.getByDataSource).toHaveBeenCalledWith('repo');
      expect(text).toContain('`action.yml`');
      expect(text).toContain('**Setup Widget**');
      expect(text).toContain('Configures widgets');
      expect(text).toContain('`token` (required)');
      expect(text).toContain('`cache-key`');
      expect(text).toContain('`tools/build/action.yaml`');
      expect(text).not.toContain('ci.yml');
    });

    it('includes searchable partial repositories', async () => {
      const partial = makeDs('repo', 'indexing');
      const { handler } = makeHandler(
        [partial],
        [],
        { repo: 2 },
        {},
        [makeFileStats('action.yaml')],
        [makeChunk('action.yaml', 'name: Partial Action')],
      );

      const result = await handler.handleListActions(
        { input: { repository: 'repo' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('## test/repo (partial)');
      expect(result.parts[0].value).toContain('**Partial Action**');
    });
  });

  describe('handleFileTree', () => {
    it('renders a filtered file tree and marks partial repositories', async () => {
      const partial = makeDs('repo', 'indexing');
      const { handler } = makeHandler(
        [partial],
        [],
        { repo: 3 },
        {},
        [
          makeFileStats('src/index.ts', 40),
          makeFileStats('src/index.test.ts', 20),
          makeFileStats('docs/readme.md', 30),
        ],
      );

      const result = await handler.handleFileTree(
        {
          input: {
            repository: 'test/repo',
            path: 'src',
            exclude: ['**/*.test.ts'],
            pageSize: 20,
          },
        } as any,
        dummyToken as any,
      );

      const text = result.parts[0].value;
      expect(text).toContain('test/repo@main [partial]');
      expect(text).toContain('index.ts');
      expect(text).not.toContain('index.test.ts');
      expect(text).not.toContain('readme.md');
    });
  });
});
