import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track registered commands
const commands = new Map<string, (...args: any[]) => any>();

vi.mock('vscode', () => ({
  commands: {
    registerCommand: vi.fn().mockImplementation((name: string, handler: any) => {
      commands.set(name, handler);
      return { dispose: vi.fn() };
    }),
  },
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn().mockImplementation((_options: any, task: any) => task()),
  },
  ProgressLocation: { Notification: 15 },
}));

import * as vscode from 'vscode';
import { registerCommands } from '../../../src/ui/commands';
import { DataSourceConfig } from '../../../src/config/configSchema';

describe('registerCommands', () => {
  let configManager: any;
  let dataSourceManager: any;
  let embeddingManager: any;
  let providerRegistry: any;
  let wizardFactory: any;
  let context: any;
  let workspaceConfigManager: any;
  let agentInstaller: any;

  const ds1: DataSourceConfig = {
    id: 'ds-1', repoUrl: '', owner: 'acme', repo: 'widgets', branch: 'main',
    includePatterns: [], excludePatterns: [], syncSchedule: 'manual',
    lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
  };

  beforeEach(() => {
    commands.clear();
    vi.clearAllMocks();

    configManager = {
      getDataSources: vi.fn().mockReturnValue([ds1]),
      getDataSource: vi.fn().mockImplementation((id: string) => id === ds1.id ? ds1 : undefined),
      updateDataSource: vi.fn(),
    };
    dataSourceManager = {
      remove: vi.fn(),
      sync: vi.fn(),
      syncAll: vi.fn(),
    };
    embeddingManager = {
      manageEmbeddings: vi.fn(),
      rebuildEmbeddings: vi.fn(),
      refresh: vi.fn(),
    };
    providerRegistry = {
      setApiKey: vi.fn(),
      setAzureApiKey: vi.fn(),
    };
    wizardFactory = vi.fn().mockReturnValue({ run: vi.fn() });
    workspaceConfigManager = {
      exportConfig: vi.fn(),
      importFromWorkspace: vi.fn(),
    };
    agentInstaller = {
      install: vi.fn().mockResolvedValue(2),
    };
    context = { subscriptions: { push: vi.fn() } };

    registerCommands(
      context,
      configManager,
      dataSourceManager,
      embeddingManager,
      providerRegistry,
      wizardFactory,
      workspaceConfigManager,
      agentInstaller,
    );
  });

  it('registers all expected commands', () => {
    expect(commands.has('yoink.addRepository')).toBe(true);
    expect(commands.has('yoink.removeRepository')).toBe(true);
    expect(commands.has('yoink.syncDataSource')).toBe(true);
    expect(commands.has('yoink.syncAllDataSources')).toBe(true);
    expect(commands.has('yoink.manageEmbeddings')).toBe(true);
    expect(commands.has('yoink.rebuildEmbeddings')).toBe(true);
    expect(commands.has('yoink.setApiKey')).toBe(true);
  });

  it('addRepository runs the wizard', async () => {
    const mockWizard = { run: vi.fn() };
    wizardFactory.mockReturnValue(mockWizard);

    await commands.get('yoink.addRepository')!();

    expect(wizardFactory).toHaveBeenCalled();
    expect(mockWizard.run).toHaveBeenCalled();
  });

  it('removeRepository calls dataSourceManager.remove', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue({
      label: 'acme/widgets', id: 'ds-1',
    });

    await commands.get('yoink.removeRepository')!();

    expect(dataSourceManager.remove).toHaveBeenCalledWith('ds-1');
    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        location: 15,
        title: 'Removing acme/widgets...',
        cancellable: false,
      }),
      expect.any(Function),
    );
  });

  it('removeRepository does nothing when no selection', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue(undefined);

    await commands.get('yoink.removeRepository')!();

    expect(dataSourceManager.remove).not.toHaveBeenCalled();
  });

  it('removeRepository shows message when no data sources', async () => {
    configManager.getDataSources.mockReturnValue([]);

    await commands.get('yoink.removeRepository')!();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No data sources configured.',
    );
  });

  it('removeRepository excludes deleting data sources', async () => {
    const deleting = { ...ds1, id: 'ds-2', owner: 'acme', repo: 'big', status: 'deleting' as const };
    configManager.getDataSources.mockReturnValue([ds1, deleting]);
    (vscode.window.showQuickPick as any).mockResolvedValue(undefined);

    await commands.get('yoink.removeRepository')!();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'ds-1', label: 'acme/widgets' })],
      { placeHolder: 'Select a data source to remove' },
    );
  });

  it('removeRepository reports delete failures', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue({
      label: 'acme/widgets', id: 'ds-1',
    });
    dataSourceManager.remove.mockRejectedValue(new Error('database locked'));

    await commands.get('yoink.removeRepository')!();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Yoink: Failed to remove acme/widgets: database locked',
    );
  });

  it('syncDataSource queues a sync', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue({
      label: 'acme/widgets', id: 'ds-1',
    });

    await commands.get('yoink.syncDataSource')!();

    expect(dataSourceManager.sync).toHaveBeenCalledWith('ds-1');
  });

  it('syncAllDataSources syncs all', async () => {
    await commands.get('yoink.syncAllDataSources')!();

    expect(dataSourceManager.syncAll).toHaveBeenCalled();
  });

  it('tree delete uses progress notification', async () => {
    (vscode.window.showWarningMessage as any).mockResolvedValue('Remove');

    await commands.get('yoink.removeDataSourceFromTree')!({ dataSource: ds1 } as any);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        location: 15,
        title: 'Removing acme/widgets...',
        cancellable: false,
      }),
      expect.any(Function),
    );
    expect(dataSourceManager.remove).toHaveBeenCalledWith('ds-1');
  });

  it('tree delete reports failures gracefully', async () => {
    (vscode.window.showWarningMessage as any).mockResolvedValue('Remove');
    dataSourceManager.remove.mockRejectedValue(new Error('database locked'));

    await commands.get('yoink.removeDataSourceFromTree')!({ dataSource: ds1 } as any);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Yoink: Failed to remove acme/widgets: database locked',
    );
  });

  it('tree commands guard stale data source items', async () => {
    configManager.getDataSource.mockReturnValue(undefined);

    await commands.get('yoink.syncDataSourceFromTree')!({ dataSource: ds1 } as any);
    await commands.get('yoink.removeDataSourceFromTree')!({ dataSource: ds1 } as any);
    await commands.get('yoink.editDataSourceFromTree')!({ dataSource: ds1 } as any);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Data source is no longer configured.',
    );
    expect(dataSourceManager.sync).not.toHaveBeenCalled();
    expect(dataSourceManager.remove).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('tree commands guard deleting data source items', async () => {
    const deleting = { ...ds1, status: 'deleting' as const };
    configManager.getDataSource.mockReturnValue(deleting);

    await commands.get('yoink.syncDataSourceFromTree')!({ dataSource: deleting } as any);
    await commands.get('yoink.removeDataSourceFromTree')!({ dataSource: deleting } as any);
    await commands.get('yoink.editDataSourceFromTree')!({ dataSource: deleting } as any);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'acme/widgets is currently being removed.',
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'acme/widgets is already being removed.',
    );
    expect(dataSourceManager.sync).not.toHaveBeenCalled();
    expect(dataSourceManager.remove).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('editDataSourceFromTree persists include and exclude patterns', async () => {
    const editable = {
      ...ds1,
      description: 'old description',
      includePatterns: ['src/**/*.ts'],
      excludePatterns: ['fixtures/**'],
      syncSchedule: 'manual' as const,
    };
    configManager.getDataSource.mockReturnValue(editable);
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('new description')
      .mockResolvedValueOnce('src/**/*.ts, docs/**/*.md')
      .mockResolvedValueOnce('examples/**, vendor/**');
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Daily',
      value: 'daily',
    });

    await commands.get('yoink.editDataSourceFromTree')!({ dataSource: editable } as any);

    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Edit acme/widgets (1/4)',
        value: 'old description',
      }),
    );
    expect(configManager.updateDataSource).toHaveBeenCalledWith('ds-1', {
      description: 'new description',
      syncSchedule: 'daily',
      includePatterns: ['src/**/*.ts', 'docs/**/*.md'],
      excludePatterns: ['examples/**', 'vendor/**'],
      lastSyncCommitSha: null,
    });
    expect(dataSourceManager.sync).toHaveBeenCalledWith('ds-1');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Updated acme/widgets. Re-index queued to apply file pattern changes.',
    );
  });

  it('editDataSourceFromTree stores empty exclude patterns', async () => {
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('src/**/*.ts')
      .mockResolvedValueOnce('');
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Manual',
      value: 'manual',
    });

    await commands.get('yoink.editDataSourceFromTree')!({ dataSource: ds1 } as any);

    expect(configManager.updateDataSource).toHaveBeenCalledWith('ds-1', {
      description: undefined,
      syncSchedule: 'manual',
      includePatterns: ['src/**/*.ts'],
      excludePatterns: [],
      lastSyncCommitSha: null,
    });
    expect(dataSourceManager.sync).toHaveBeenCalledWith('ds-1');
  });

  it('editDataSourceFromTree does not reindex when patterns are unchanged', async () => {
    const editable = {
      ...ds1,
      description: 'old description',
      includePatterns: ['src/**/*.ts'],
      excludePatterns: ['fixtures/**'],
      syncSchedule: 'manual' as const,
    };
    configManager.getDataSource.mockReturnValue(editable);
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('new description')
      .mockResolvedValueOnce('src/**/*.ts')
      .mockResolvedValueOnce('fixtures/**');
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Manual',
      value: 'manual',
    });

    await commands.get('yoink.editDataSourceFromTree')!({ dataSource: editable } as any);

    expect(configManager.updateDataSource).toHaveBeenCalledWith('ds-1', {
      description: 'new description',
      syncSchedule: 'manual',
      includePatterns: ['src/**/*.ts'],
      excludePatterns: ['fixtures/**'],
    });
    expect(dataSourceManager.sync).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Updated acme/widgets.',
    );
  });

  it('editDataSourceFromTree cancels without saving when exclude input is dismissed', async () => {
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('new description')
      .mockResolvedValueOnce('src/**/*.ts')
      .mockResolvedValueOnce(undefined);
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Manual',
      value: 'manual',
    });

    await commands.get('yoink.editDataSourceFromTree')!({ dataSource: ds1 } as any);

    expect(configManager.updateDataSource).not.toHaveBeenCalled();
  });

  it('manageEmbeddings delegates to the embedding manager', async () => {
    await commands.get('yoink.manageEmbeddings')!();

    expect(embeddingManager.manageEmbeddings).toHaveBeenCalled();
  });

  it('rebuildEmbeddings delegates to the embedding manager', async () => {
    await commands.get('yoink.rebuildEmbeddings')!();

    expect(embeddingManager.rebuildEmbeddings).toHaveBeenCalled();
  });

  it('setApiKey saves the key', async () => {
    (vscode.window.showInputBox as any).mockResolvedValue('sk-test-key-123');

    await commands.get('yoink.setApiKey')!();

    expect(providerRegistry.setApiKey).toHaveBeenCalledWith('sk-test-key-123');
  });

  it('setApiKey does nothing when cancelled', async () => {
    (vscode.window.showInputBox as any).mockResolvedValue(undefined);

    await commands.get('yoink.setApiKey')!();

    expect(providerRegistry.setApiKey).not.toHaveBeenCalled();
  });

  it('registers export and import commands', () => {
    expect(commands.has('yoink.exportConfig')).toBe(true);
    expect(commands.has('yoink.importConfig')).toBe(true);
  });

  it('exportConfig delegates to workspaceConfigManager', async () => {
    await commands.get('yoink.exportConfig')!();
    expect(workspaceConfigManager.exportConfig).toHaveBeenCalled();
  });

  it('importConfig delegates to workspaceConfigManager', async () => {
    await commands.get('yoink.importConfig')!();
    expect(workspaceConfigManager.importFromWorkspace).toHaveBeenCalled();
  });
});
