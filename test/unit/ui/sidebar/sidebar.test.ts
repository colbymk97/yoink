import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: any;
    collapsibleState?: number;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(public id: string, public color?: any) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  EventEmitter: class {
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire(data: any) { this.listeners.forEach((l) => l(data)); }
    dispose() {}
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, defaultValue?: any) => defaultValue }),
  },
}));

import {
  DataSourceTreeItem,
  DataSourceInfoItem,
  DataSourceFileItem,
  EmbeddingTreeItem,
} from '../../../../src/ui/sidebar/sidebarTreeItems';
import { DataSourceTreeProvider, EmbeddingTreeProvider } from '../../../../src/ui/sidebar/sidebarProvider';
import { DataSourceConfig } from '../../../../src/config/configSchema';

function makeDs(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: 'ds-1', repoUrl: '', owner: 'acme', repo: 'widgets', branch: 'main',
    includePatterns: [], excludePatterns: [], syncSchedule: 'manual',
    lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
    ...overrides,
  };
}

describe('DataSourceTreeItem', () => {
  it('displays owner/repo as label', () => {
    const item = new DataSourceTreeItem(makeDs());
    expect(item.label).toBe('acme/widgets');
  });

  it('shows branch in description', () => {
    const item = new DataSourceTreeItem(makeDs());
    expect(item.description).toContain('main');
  });

  it('shows status icon for ready state', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'ready' }));
    expect(item.description).toContain('$(check)');
  });

  it('shows status icon for error state', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'error', errorMessage: 'fail' }));
    expect(item.description).toContain('$(error)');
    expect(item.tooltip).toContain('fail');
  });

  it('shows status icon for indexing state', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'indexing' }));
    expect(item.description).toContain('$(sync~spin)');
  });

  it('shows last synced time in tooltip', () => {
    const item = new DataSourceTreeItem(makeDs({ lastSyncedAt: '2025-01-01T00:00:00Z' }));
    expect(item.tooltip).toContain('2025-01-01');
  });

  it('sets contextValue to dataSource', () => {
    const item = new DataSourceTreeItem(makeDs());
    expect(item.contextValue).toBe('dataSource');
  });

  it('is collapsible when status is ready', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'ready' }));
    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  it('is not collapsible when status is indexing', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'indexing' }));
    expect(item.collapsibleState).toBe(0); // None
  });

  it('is not collapsible when status is error', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'error' }));
    expect(item.collapsibleState).toBe(0); // None
  });

  it('is not collapsible when status is queued', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'queued' }));
    expect(item.collapsibleState).toBe(0); // None
  });
});

describe('DataSourceInfoItem', () => {
  it('displays stats in label', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 12, chunkCount: 87, totalTokens: 4230 },
      makeDs(),
    );
    expect(item.label).toContain('12');
    expect(item.label).toContain('87');
    expect(item.label).toContain('4,230');
  });

  it('sets contextValue to dataSourceInfo', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 1, chunkCount: 1, totalTokens: 10 },
      makeDs(),
    );
    expect(item.contextValue).toBe('dataSourceInfo');
  });

  it('includes commit SHA in tooltip when available', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 1, chunkCount: 1, totalTokens: 10 },
      makeDs({ lastSyncCommitSha: 'abc1234567890' }),
    );
    expect(item.tooltip).toContain('abc1234');
  });

  it('is not collapsible', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 1, chunkCount: 1, totalTokens: 10 },
      makeDs(),
    );
    expect(item.collapsibleState).toBe(0); // None
  });
});

describe('DataSourceFileItem', () => {
  it('displays file path as label', () => {
    const item = new DataSourceFileItem({ filePath: 'src/index.ts', chunkCount: 3, tokenCount: 150 });
    expect(item.label).toBe('src/index.ts');
  });

  it('shows chunk count in description', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 5, tokenCount: 100 });
    expect(item.description).toBe('5 chunks');
  });

  it('singularizes chunk count of 1', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 1, tokenCount: 50 });
    expect(item.description).toBe('1 chunk');
  });

  it('sets contextValue to dataSourceFile', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 1, tokenCount: 50 });
    expect(item.contextValue).toBe('dataSourceFile');
  });

  it('is not collapsible', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 1, tokenCount: 50 });
    expect(item.collapsibleState).toBe(0); // None
  });
});


describe('DataSourceTreeProvider', () => {
  function makeChunkStore(stats = { fileCount: 0, chunkCount: 0, totalTokens: 0 }, fileStats: any[] = []) {
    return {
      getDataSourceStats: vi.fn().mockReturnValue(stats),
      getFileStats: vi.fn().mockReturnValue(fileStats),
    } as any;
  }

  function makeProgressTracker() {
    return {
      get: vi.fn().mockReturnValue(undefined),
      onDidChange: (cb: () => void) => { return { dispose: vi.fn() }; },
    } as any;
  }

  it('returns data source tree items from config at root', () => {
    const changeCallbacks: Array<() => void> = [];
    const configManager = {
      getDataSources: () => [makeDs(), makeDs({ id: 'ds-2', owner: 'other', repo: 'lib' })],
      onDidChange: (cb: () => void) => { changeCallbacks.push(cb); return { dispose: vi.fn() }; },
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const children = provider.getChildren();

    expect(children).toHaveLength(2);
    expect(children[0].label).toBe('acme/widgets');
    expect(children[1].label).toBe('other/lib');
  });

  it('returns info and file items when expanding a ready data source', () => {
    const configManager = {
      getDataSources: () => [makeDs()],
      onDidChange: () => ({ dispose: vi.fn() }),
    } as any;

    const chunkStore = makeChunkStore(
      { fileCount: 2, chunkCount: 5, totalTokens: 200 },
      [
        { filePath: 'a.ts', chunkCount: 3, tokenCount: 120 },
        { filePath: 'b.ts', chunkCount: 2, tokenCount: 80 },
      ],
    );

    const provider = new DataSourceTreeProvider(configManager, chunkStore, makeProgressTracker());
    const dsItem = new DataSourceTreeItem(makeDs());
    const children = provider.getChildren(dsItem);

    expect(children).toHaveLength(3);
    expect(children[0]).toBeInstanceOf(DataSourceInfoItem);
    expect(children[1]).toBeInstanceOf(DataSourceFileItem);
    expect(children[2]).toBeInstanceOf(DataSourceFileItem);
    expect(children[1].label).toBe('a.ts');
    expect(children[2].label).toBe('b.ts');
  });

  it('returns empty array for non-ready data source children', () => {
    const configManager = {
      getDataSources: () => [],
      onDidChange: () => ({ dispose: vi.fn() }),
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const dsItem = new DataSourceTreeItem(makeDs({ status: 'indexing' }));
    const children = provider.getChildren(dsItem);

    expect(children).toHaveLength(0);
  });

  it('fires onDidChangeTreeData on config change', () => {
    const changeCallbacks: Array<() => void> = [];
    const configManager = {
      getDataSources: () => [],
      onDidChange: (cb: () => void) => { changeCallbacks.push(cb); return { dispose: vi.fn() }; },
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    changeCallbacks.forEach((cb) => cb());
    expect(listener).toHaveBeenCalled();
  });
});

describe('EmbeddingTreeItem', () => {
  it('shows configured state', () => {
    const item = new EmbeddingTreeItem({
      provider: 'openai',
      providerLabel: 'OpenAI',
      identifier: 'text-embedding-3-small',
      identifierLabel: 'Model',
      dimensions: 1536,
      requiresApiKey: true,
      hasApiKey: true,
      missingFields: [],
      isConfigured: true,
      fingerprint: 'fp-openai',
      isRebuilding: false,
      isStale: false,
      statusLabel: 'Configured',
      actionCommand: 'yoink.manageEmbeddings',
      tooltip: 'configured',
    });

    expect(item.label).toBe('OpenAI: text-embedding-3-small');
    expect(item.description).toContain('Configured');
    expect(item.contextValue).toBe('embeddingReady');
    expect(item.command?.command).toBe('yoink.manageEmbeddings');
  });

  it('shows stale state as rebuildable', () => {
    const item = new EmbeddingTreeItem({
      provider: 'azure-openai',
      providerLabel: 'Azure OpenAI',
      identifier: 'embed-prod',
      identifierLabel: 'Deployment',
      dimensions: 3072,
      requiresApiKey: true,
      hasApiKey: true,
      missingFields: [],
      isConfigured: true,
      fingerprint: 'fp-azure',
      isRebuilding: false,
      isStale: true,
      statusLabel: 'Rebuild required',
      actionCommand: 'yoink.rebuildEmbeddings',
      tooltip: 'rebuild required',
    });

    expect(item.description).toContain('Rebuild required');
    expect(item.contextValue).toBe('embeddingStale');
    expect(item.command?.command).toBe('yoink.rebuildEmbeddings');
  });
});

describe('EmbeddingTreeProvider', () => {
  it('returns the embedding status item', async () => {
    const embeddingManager = {
      getStatus: vi.fn().mockResolvedValue({
        provider: 'local',
        providerLabel: 'Local',
        identifier: 'nomic-embed-text',
        identifierLabel: 'Model',
        dimensions: 768,
        requiresApiKey: false,
        hasApiKey: false,
        missingFields: [],
        isConfigured: true,
        fingerprint: 'fp-local',
        isRebuilding: false,
        isStale: false,
        statusLabel: 'Configured',
        actionCommand: 'yoink.manageEmbeddings',
        tooltip: 'configured',
      }),
      onDidChange: (listener: () => void) => ({ dispose: vi.fn() }),
    } as any;

    const provider = new EmbeddingTreeProvider(embeddingManager);
    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmbeddingTreeItem);
    expect(children[0].label).toBe('Local: nomic-embed-text');
  });
});
