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
  let providerRegistry: any;
  let wizardFactory: any;
  let context: any;

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
      getTools: vi.fn().mockReturnValue([
        { id: 't-1', name: 'my-tool', description: 'A tool', dataSourceIds: ['ds-1'] },
      ]),
      getTool: vi.fn().mockReturnValue({ id: 't-1', name: 'my-tool', description: 'A tool', dataSourceIds: ['ds-1'] }),
      updateTool: vi.fn(),
    };
    dataSourceManager = {
      remove: vi.fn(),
      sync: vi.fn(),
      syncAll: vi.fn(),
    };
    providerRegistry = {
      setApiKey: vi.fn(),
    };
    wizardFactory = vi.fn().mockReturnValue({ run: vi.fn() });
    context = { subscriptions: { push: vi.fn() } };

    registerCommands(context, configManager, dataSourceManager, providerRegistry, wizardFactory);
  });

  it('registers all expected commands', () => {
    expect(commands.has('repoLens.addRepository')).toBe(true);
    expect(commands.has('repoLens.removeRepository')).toBe(true);
    expect(commands.has('repoLens.syncDataSource')).toBe(true);
    expect(commands.has('repoLens.syncAllDataSources')).toBe(true);
    expect(commands.has('repoLens.setApiKey')).toBe(true);
    expect(commands.has('repoLens.editTool')).toBe(true);
  });

  it('addRepository runs the wizard', async () => {
    const mockWizard = { run: vi.fn() };
    wizardFactory.mockReturnValue(mockWizard);

    await commands.get('repoLens.addRepository')!();

    expect(wizardFactory).toHaveBeenCalled();
    expect(mockWizard.run).toHaveBeenCalled();
  });

  it('removeRepository calls dataSourceManager.remove', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue({
      label: 'acme/widgets', id: 'ds-1',
    });

    await commands.get('repoLens.removeRepository')!();

    expect(dataSourceManager.remove).toHaveBeenCalledWith('ds-1');
  });

  it('removeRepository does nothing when no selection', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue(undefined);

    await commands.get('repoLens.removeRepository')!();

    expect(dataSourceManager.remove).not.toHaveBeenCalled();
  });

  it('removeRepository shows message when no data sources', async () => {
    configManager.getDataSources.mockReturnValue([]);

    await commands.get('repoLens.removeRepository')!();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No data sources configured.',
    );
  });

  it('syncDataSource queues a sync', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue({
      label: 'acme/widgets', id: 'ds-1',
    });

    await commands.get('repoLens.syncDataSource')!();

    expect(dataSourceManager.sync).toHaveBeenCalledWith('ds-1');
  });

  it('syncAllDataSources syncs all', async () => {
    await commands.get('repoLens.syncAllDataSources')!();

    expect(dataSourceManager.syncAll).toHaveBeenCalled();
  });

  it('setApiKey saves the key', async () => {
    (vscode.window.showInputBox as any).mockResolvedValue('sk-test-key-123');

    await commands.get('repoLens.setApiKey')!();

    expect(providerRegistry.setApiKey).toHaveBeenCalledWith('sk-test-key-123');
  });

  it('setApiKey does nothing when cancelled', async () => {
    (vscode.window.showInputBox as any).mockResolvedValue(undefined);

    await commands.get('repoLens.setApiKey')!();

    expect(providerRegistry.setApiKey).not.toHaveBeenCalled();
  });

  it('editTool updates tool description', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValue({
      label: 'my-tool', id: 't-1',
    });
    (vscode.window.showInputBox as any).mockResolvedValue('Updated description');

    await commands.get('repoLens.editTool')!();

    expect(configManager.updateTool).toHaveBeenCalledWith('t-1', {
      description: 'Updated description',
    });
  });

  it('editTool shows message when no tools configured', async () => {
    configManager.getTools.mockReturnValue([]);

    await commands.get('repoLens.editTool')!();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No tools configured.',
    );
  });
});
