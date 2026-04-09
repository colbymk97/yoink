import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { DataSourceConfig, ToolConfig } from '../../../src/config/configSchema';

// --- Helpers ---

function makeProvider(): EmbeddingProvider {
  return {
    id: 'test',
    maxBatchSize: 100,
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

function makeTool(id: string, name: string, dsIds: string[]): ToolConfig {
  return { id, name, description: `A test tool for ${name}`, dataSourceIds: dsIds };
}

function makeHandler(
  dataSources: DataSourceConfig[],
  tools: ToolConfig[],
  searchResults: any[] = [],
) {
  const dsMap = new Map(dataSources.map((ds) => [ds.id, ds]));
  const toolMap = new Map(tools.map((t) => [t.id, t]));

  const configManager = {
    getTool: (id: string) => toolMap.get(id),
    getTools: () => tools,
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

  const contextBuilder = {
    format: vi.fn().mockReturnValue('formatted results'),
  } as any;

  const chunkStore = {
    getDataSourceStats: vi.fn().mockReturnValue({
      fileCount: 10,
      chunkCount: 50,
      totalTokens: 12000,
    }),
  } as any;

  const handler = new ToolHandler(configManager, providerRegistry, retriever, contextBuilder, chunkStore);
  return { handler, retriever, contextBuilder, providerRegistry, chunkStore };
}

const dummyToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

describe('ToolHandler', () => {
  describe('handleGlobalSearch', () => {
    it('searches all ready data sources', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const ds2 = makeDs('ds-2', 'indexing');
      const { handler, retriever } = makeHandler([ds1, ds2], []);

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
      const { handler, retriever } = makeHandler([ds1, ds2], []);

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

    it('scopes search by tool name', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const ds2 = makeDs('ds-2', 'ready');
      const tool = makeTool('t-1', 'my-tool', ['ds-1']);
      const { handler, retriever } = makeHandler([ds1, ds2], [tool]);

      await handler.handleGlobalSearch(
        { input: { query: 'test', tool: 'my-tool' } } as any,
        dummyToken as any,
      );

      expect(retriever.search).toHaveBeenCalledWith(
        'test',
        ['ds-1'],
        expect.anything(),
        10,
      );
    });

    it('repository takes precedence over tool', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const ds2 = makeDs('ds-2', 'ready');
      const tool = makeTool('t-1', 'my-tool', ['ds-1']);
      const { handler, retriever } = makeHandler([ds1, ds2], [tool]);

      await handler.handleGlobalSearch(
        { input: { query: 'test', repository: 'test/ds-2', tool: 'my-tool' } } as any,
        dummyToken as any,
      );

      expect(retriever.search).toHaveBeenCalledWith(
        'test',
        ['ds-2'],
        expect.anything(),
        10,
      );
    });

    it('returns error for unknown tool name', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const tool = makeTool('t-1', 'my-tool', ['ds-1']);
      const { handler } = makeHandler([ds1], [tool]);

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test', tool: 'nonexistent' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('not found');
      expect(result.parts[0].value).toContain('my-tool');
    });

    it('returns error when tool has no ready data sources', async () => {
      const ds1 = makeDs('ds-1', 'indexing');
      const ds2 = makeDs('ds-2', 'ready'); // a ready source so we pass the early check
      const tool = makeTool('t-1', 'my-tool', ['ds-1']); // tool only references the non-ready source
      const { handler } = makeHandler([ds1, ds2], [tool]);

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test', tool: 'my-tool' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('no ready data sources');
    });

    it('returns error when no repositories indexed', async () => {
      const { handler } = makeHandler([], []);

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('No repositories are indexed');
    });

    it('returns error message when search fails', async () => {
      const ds1 = makeDs('ds-1');
      const { handler, retriever } = makeHandler([ds1], []);
      retriever.search.mockRejectedValue(new Error('embedding failed'));

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('Search failed');
      expect(result.parts[0].value).toContain('embedding failed');
    });

    it('formats retrieval results via contextBuilder', async () => {
      const ds1 = makeDs('ds-1');
      const mockResults = [{ chunk: { id: 'c1' }, distance: 0.1 }];
      const { handler, contextBuilder } = makeHandler([ds1], [], mockResults);
      contextBuilder.format.mockReturnValue('**formatted**');

      const result = await handler.handleGlobalSearch(
        { input: { query: 'test' } } as any,
        dummyToken as any,
      );

      expect(contextBuilder.format).toHaveBeenCalledWith(mockResults);
      expect(result.parts[0].value).toContain('**formatted**');
    });
  });

  describe('handle', () => {
    it('searches scoped to tool data sources', async () => {
      const ds1 = makeDs('ds-1');
      const tool = makeTool('t-1', 'my-tool', ['ds-1']);
      const { handler, retriever } = makeHandler([ds1], [tool]);

      await handler.handle(
        't-1',
        { input: { query: 'find me' } } as any,
        dummyToken as any,
      );

      expect(retriever.search).toHaveBeenCalledWith(
        'find me',
        ['ds-1'],
        expect.anything(),
        10,
      );
    });

    it('returns error for unknown tool ID', async () => {
      const { handler } = makeHandler([], []);

      const result = await handler.handle(
        'nonexistent',
        { input: { query: 'test' } } as any,
        dummyToken as any,
      );

      expect(result.parts[0].value).toContain('not found');
    });
  });

  describe('handleList', () => {
    it('returns data source info with stats for ready sources', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const { handler, chunkStore } = makeHandler([ds1], []);

      const result = await handler.handleList(dummyToken as any);

      expect(chunkStore.getDataSourceStats).toHaveBeenCalledWith('ds-1');
      expect(result.parts[0].value).toContain('test/ds-1@main');
      expect(result.parts[0].value).toContain('ready');
      expect(result.parts[0].value).toContain('10 files');
      expect(result.parts[0].value).toContain('50 chunks');
    });

    it('skips stats for non-ready sources', async () => {
      const ds1 = makeDs('ds-1', 'indexing');
      const { handler, chunkStore } = makeHandler([ds1], []);

      const result = await handler.handleList(dummyToken as any);

      expect(chunkStore.getDataSourceStats).not.toHaveBeenCalled();
      expect(result.parts[0].value).toContain('indexing');
    });

    it('lists tools with resolved data source references', async () => {
      const ds1 = makeDs('ds-1', 'ready');
      const tool = makeTool('t-1', 'my-tool', ['ds-1']);
      const { handler } = makeHandler([ds1], [tool]);

      const result = await handler.handleList(dummyToken as any);

      expect(result.parts[0].value).toContain('my-tool');
      expect(result.parts[0].value).toContain('test/ds-1@main');
    });

    it('returns no data sources message when empty', async () => {
      const { handler } = makeHandler([], []);

      const result = await handler.handleList(dummyToken as any);

      expect(result.parts[0].value).toContain('No data sources configured');
      expect(result.parts[0].value).toContain('No tools configured');
    });
  });
});
