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
}));

import { DataSourceTreeItem, ToolTreeItem } from '../../../../src/ui/sidebar/sidebarTreeItems';
import { DataSourceTreeProvider, ToolTreeProvider } from '../../../../src/ui/sidebar/sidebarProvider';
import { DataSourceConfig, ToolConfig } from '../../../../src/config/configSchema';

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
});

describe('ToolTreeItem', () => {
  const configManager = {
    getDataSource: (id: string) =>
      id === 'ds-1' ? makeDs() : undefined,
  } as any;

  it('displays tool name as label', () => {
    const tool: ToolConfig = { id: 't-1', name: 'my-tool', description: 'Desc', dataSourceIds: ['ds-1'] };
    const item = new ToolTreeItem(tool, configManager);
    expect(item.label).toBe('my-tool');
  });

  it('shows source count in description', () => {
    const tool: ToolConfig = { id: 't-1', name: 'tool', description: '', dataSourceIds: ['ds-1'] };
    const item = new ToolTreeItem(tool, configManager);
    expect(item.description).toBe('1 source');
  });

  it('pluralizes sources correctly', () => {
    const tool: ToolConfig = { id: 't-1', name: 'tool', description: '', dataSourceIds: ['ds-1', 'ds-2'] };
    const item = new ToolTreeItem(tool, configManager);
    expect(item.description).toBe('2 sources');
  });

  it('shows repo names in tooltip', () => {
    const tool: ToolConfig = { id: 't-1', name: 'tool', description: 'Desc', dataSourceIds: ['ds-1'] };
    const item = new ToolTreeItem(tool, configManager);
    expect(item.tooltip).toContain('acme/widgets');
  });

  it('sets contextValue to tool', () => {
    const tool: ToolConfig = { id: 't-1', name: 'tool', description: '', dataSourceIds: [] };
    const item = new ToolTreeItem(tool, configManager);
    expect(item.contextValue).toBe('tool');
  });
});

describe('DataSourceTreeProvider', () => {
  it('returns data source tree items from config', () => {
    const changeCallbacks: Array<() => void> = [];
    const configManager = {
      getDataSources: () => [makeDs(), makeDs({ id: 'ds-2', owner: 'other', repo: 'lib' })],
      onDidChange: (cb: () => void) => { changeCallbacks.push(cb); return { dispose: vi.fn() }; },
    } as any;

    const provider = new DataSourceTreeProvider(configManager);
    const children = provider.getChildren();

    expect(children).toHaveLength(2);
    expect(children[0].label).toBe('acme/widgets');
    expect(children[1].label).toBe('other/lib');
  });

  it('fires onDidChangeTreeData on config change', () => {
    const changeCallbacks: Array<() => void> = [];
    const configManager = {
      getDataSources: () => [],
      onDidChange: (cb: () => void) => { changeCallbacks.push(cb); return { dispose: vi.fn() }; },
    } as any;

    const provider = new DataSourceTreeProvider(configManager);
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    changeCallbacks.forEach((cb) => cb());
    expect(listener).toHaveBeenCalled();
  });
});

describe('ToolTreeProvider', () => {
  it('returns tool tree items from config', () => {
    const tool: ToolConfig = { id: 't-1', name: 'my-tool', description: '', dataSourceIds: [] };
    const configManager = {
      getTools: () => [tool],
      getDataSource: () => undefined,
      onDidChange: (cb: () => void) => ({ dispose: vi.fn() }),
    } as any;

    const provider = new ToolTreeProvider(configManager);
    const children = provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0].label).toBe('my-tool');
  });
});
