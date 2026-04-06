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

function makeTool(id: string, dsIds: string[]): ToolConfig {
  return { id, name: `tool-${id}`, description: 'A test tool', dataSourceIds: dsIds };
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
    getDataSources: () => dataSources,
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

  const handler = new ToolHandler(configManager, providerRegistry, retriever, contextBuilder);
  return { handler, retriever, contextBuilder, providerRegistry };
}

const dummyToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

describe('ToolHandler', () => {
  it('handleGlobalSearch searches all ready data sources', async () => {
    const ds1 = makeDs('ds-1', 'ready');
    const ds2 = makeDs('ds-2', 'indexing');
    const { handler, retriever } = makeHandler([ds1, ds2], []);

    const result = await handler.handleGlobalSearch(
      { input: { query: 'test query' } } as any,
      dummyToken as any,
    );

    // Should only pass ready data sources
    expect(retriever.search).toHaveBeenCalledWith(
      'test query',
      ['ds-1'],
      expect.anything(),
      10, // default topK
    );
    expect(result.parts).toHaveLength(1);
  });

  it('handle searches scoped to tool data sources', async () => {
    const ds1 = makeDs('ds-1');
    const tool = makeTool('t-1', ['ds-1']);
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
    expect(result.parts[0].value).toBe('**formatted**');
  });
});
