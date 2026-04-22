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
    showInformationMessage: vi.fn(),
  },
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
