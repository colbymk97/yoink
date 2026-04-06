import { describe, it, expect } from 'vitest';
import { ContextBuilder } from '../../../src/retrieval/contextBuilder';
import { RetrievalResult } from '../../../src/retrieval/retriever';
import { DataSourceConfig } from '../../../src/config/configSchema';

// Minimal mock for ConfigManager — only getDataSource is used by ContextBuilder
function makeMockConfigManager(dataSources: DataSourceConfig[]) {
  const dsMap = new Map(dataSources.map((ds) => [ds.id, ds]));
  return {
    getDataSource: (id: string) => dsMap.get(id),
  } as any; // cast to ConfigManager — only getDataSource is called
}

function makeResult(overrides: Partial<RetrievalResult['chunk']> = {}, distance = 0.1): RetrievalResult {
  return {
    chunk: {
      id: 'c1',
      dataSourceId: 'ds-1',
      filePath: 'src/index.ts',
      startLine: 1,
      endLine: 10,
      content: 'const hello = "world";',
      tokenCount: 5,
      ...overrides,
    },
    distance,
  };
}

describe('ContextBuilder', () => {
  const ds: DataSourceConfig = {
    id: 'ds-1',
    repoUrl: 'https://github.com/acme/widgets',
    owner: 'acme',
    repo: 'widgets',
    branch: 'main',
    includePatterns: [],
    excludePatterns: [],
    syncSchedule: 'manual',
    lastSyncedAt: null,
    lastSyncCommitSha: null,
    status: 'ready',
  };

  it('formats results with repo label, file path, and line range', () => {
    const builder = new ContextBuilder(makeMockConfigManager([ds]));
    const output = builder.format([makeResult()]);

    expect(output).toContain('acme/widgets');
    expect(output).toContain('src/index.ts');
    expect(output).toContain('L1-L10');
    expect(output).toContain('const hello = "world"');
  });

  it('returns "No relevant results" for empty results', () => {
    const builder = new ContextBuilder(makeMockConfigManager([ds]));
    const output = builder.format([]);

    expect(output).toBe('No relevant results found.');
  });

  it('formats multiple results with numbered sections', () => {
    const builder = new ContextBuilder(makeMockConfigManager([ds]));
    const results = [
      makeResult({ id: 'c1', filePath: 'a.ts', startLine: 1, endLine: 5 }),
      makeResult({ id: 'c2', filePath: 'b.ts', startLine: 10, endLine: 20 }),
    ];

    const output = builder.format(results);
    expect(output).toContain('Result 1');
    expect(output).toContain('Result 2');
    expect(output).toContain('a.ts');
    expect(output).toContain('b.ts');
  });

  it('shows "unknown" for data sources not in config', () => {
    const builder = new ContextBuilder(makeMockConfigManager([]));
    const output = builder.format([makeResult({ dataSourceId: 'missing' })]);

    expect(output).toContain('unknown');
  });

  it('wraps content in code blocks', () => {
    const builder = new ContextBuilder(makeMockConfigManager([ds]));
    const output = builder.format([makeResult()]);

    expect(output).toContain('```');
  });
});
