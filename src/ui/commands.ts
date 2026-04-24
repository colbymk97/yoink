import * as vscode from 'vscode';
import { AddRepoWizard } from './wizard/addRepoWizard';
import { DataSourceManager } from '../sources/dataSourceManager';
import { EmbeddingProviderRegistry } from '../embedding/registry';
import { ConfigManager } from '../config/configManager';
import { DataSourceConfig, DEFAULT_EXCLUDE_PATTERNS } from '../config/configSchema';
import { WorkspaceConfigManager } from '../config/workspaceConfig';
import { DataSourceTreeItem } from './sidebar/sidebarTreeItems';
import { AgentInstaller } from '../agents/agentInstaller';
import { EmbeddingManager } from '../embedding/manager';
import { parseCommaSeparatedPatterns } from './patternInput';

export function registerCommands(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  dataSourceManager: DataSourceManager,
  embeddingManager: EmbeddingManager,
  providerRegistry: EmbeddingProviderRegistry,
  wizardFactory: () => AddRepoWizard,
  workspaceConfigManager: WorkspaceConfigManager,
  agentInstaller: AgentInstaller,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('yoink.addRepository', async () => {
      const wizard = wizardFactory();
      await wizard.run();
    }),

    vscode.commands.registerCommand('yoink.manageEmbeddings', async () => {
      await embeddingManager.manageEmbeddings();
    }),

    vscode.commands.registerCommand('yoink.rebuildEmbeddings', async () => {
      await embeddingManager.rebuildEmbeddings();
    }),

    vscode.commands.registerCommand('yoink.removeRepository', async () => {
      const allDataSources = configManager.getDataSources();
      const dataSources = allDataSources.filter((ds) => ds.status !== 'deleting');
      if (allDataSources.length === 0) {
        vscode.window.showInformationMessage('No data sources configured.');
        return;
      }
      if (dataSources.length === 0) {
        vscode.window.showInformationMessage('All configured data sources are already being removed.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        dataSources.map((ds) => ({
          label: `${ds.owner}/${ds.repo}`,
          description: ds.branch,
          id: ds.id,
        })),
        { placeHolder: 'Select a data source to remove' },
      );
      if (picked) {
        await removeDataSourceWithFeedback(dataSourceManager, picked.id, picked.label);
      }
    }),

    vscode.commands.registerCommand('yoink.syncDataSource', async () => {
      const allDataSources = configManager.getDataSources();
      const dataSources = allDataSources.filter((ds) => ds.status !== 'deleting');
      if (allDataSources.length === 0) {
        vscode.window.showInformationMessage('No data sources configured.');
        return;
      }
      if (dataSources.length === 0) {
        vscode.window.showInformationMessage('All configured data sources are currently being removed.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        dataSources.map((ds) => ({
          label: `${ds.owner}/${ds.repo}`,
          description: `${ds.status} — ${ds.branch}`,
          id: ds.id,
        })),
        { placeHolder: 'Select a data source to sync' },
      );
      if (picked) {
        await dataSourceManager.sync(picked.id);
        vscode.window.showInformationMessage(`Sync queued for ${picked.label}.`);
      }
    }),

    vscode.commands.registerCommand('yoink.syncAllDataSources', async () => {
      await dataSourceManager.syncAll();
      vscode.window.showInformationMessage('Sync queued for all data sources.');
    }),

    vscode.commands.registerCommand('yoink.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI API key',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.startsWith('sk-') ? null : 'API key should start with sk-'),
      });
      if (key) {
        await providerRegistry.setApiKey(key);
        embeddingManager.refresh();
        vscode.window.showInformationMessage('OpenAI API key saved.');
      }
    }),

    vscode.commands.registerCommand('yoink.setAzureApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Azure OpenAI API key',
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await providerRegistry.setAzureApiKey(key);
        embeddingManager.refresh();
        vscode.window.showInformationMessage('Azure OpenAI API key saved.');
      }
    }),

    // Tree-item context menu commands
    vscode.commands.registerCommand('yoink.syncDataSourceFromTree', async (item: DataSourceTreeItem) => {
      const ds = getCurrentDataSource(configManager, item);
      if (!ds) return;
      if (ds.status === 'deleting') {
        vscode.window.showInformationMessage(`${formatDataSourceLabel(ds)} is currently being removed.`);
        return;
      }
      await dataSourceManager.sync(ds.id);
      vscode.window.showInformationMessage(
        `Sync queued for ${formatDataSourceLabel(ds)}.`,
      );
    }),

    vscode.commands.registerCommand('yoink.removeDataSourceFromTree', async (item: DataSourceTreeItem) => {
      const ds = getCurrentDataSource(configManager, item);
      if (!ds) return;
      if (ds.status === 'deleting') {
        vscode.window.showInformationMessage(`${formatDataSourceLabel(ds)} is already being removed.`);
        return;
      }
      const label = formatDataSourceLabel(ds);
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${label}? This will delete all indexed data.`,
        { modal: true },
        'Remove',
      );
      if (confirm === 'Remove') {
        await removeDataSourceWithFeedback(dataSourceManager, ds.id, label);
      }
    }),

    vscode.commands.registerCommand('yoink.editDataSourceFromTree', async (item: DataSourceTreeItem) => {
      const ds = getCurrentDataSource(configManager, item);
      if (!ds) return;
      if (ds.status === 'deleting') {
        vscode.window.showInformationMessage(`${formatDataSourceLabel(ds)} is currently being removed.`);
        return;
      }
      const repoLabel = formatDataSourceLabel(ds);

      const description = await vscode.window.showInputBox({
        title: `Edit ${repoLabel} (1/4)`,
        prompt: 'Description (optional)',
        value: ds.description ?? '',
        ignoreFocusOut: true,
      });
      if (description === undefined) return;

      const scheduleItems = [
        { label: 'Manual', description: 'Only sync when manually triggered', value: 'manual' as const },
        { label: 'On Startup', description: 'Sync when VS Code starts', value: 'onStartup' as const },
        { label: 'Daily', description: 'Sync once per day', value: 'daily' as const },
      ];
      const schedulePick = await vscode.window.showQuickPick<(typeof scheduleItems)[number]>(scheduleItems, {
        title: `Edit ${repoLabel} (2/4)`,
        placeHolder: 'Sync schedule',
        ignoreFocusOut: true,
      });
      if (!schedulePick) return;

      const includeInput = await vscode.window.showInputBox({
        title: `Edit ${repoLabel} (3/4)`,
        prompt: 'Include patterns (comma-separated globs, leave empty for all files)',
        value: ds.includePatterns.join(', '),
        ignoreFocusOut: true,
      });
      if (includeInput === undefined) return;

      const includePatterns = parseCommaSeparatedPatterns(includeInput);

      const excludeInput = await vscode.window.showInputBox({
        title: `Edit ${repoLabel} (4/4)`,
        prompt: `Additional exclude patterns (comma-separated globs). Built-in excludes always apply: ${DEFAULT_EXCLUDE_PATTERNS.join(', ')}`,
        placeHolder: 'examples/**, vendor/**, **/*.generated.ts',
        value: ds.excludePatterns.join(', '),
        ignoreFocusOut: true,
      });
      if (excludeInput === undefined) return;

      const excludePatterns = parseCommaSeparatedPatterns(excludeInput);
      const patternsChanged =
        !samePatterns(ds.includePatterns, includePatterns) ||
        !samePatterns(ds.excludePatterns, excludePatterns);

      const updates: Partial<DataSourceConfig> = {
        description: description || undefined,
        syncSchedule: schedulePick.value,
        includePatterns,
        excludePatterns,
      };
      if (patternsChanged) {
        updates.lastSyncCommitSha = null;
      }

      configManager.updateDataSource(ds.id, updates);
      if (patternsChanged) {
        try {
          await dataSourceManager.sync(ds.id);
          vscode.window.showInformationMessage(`Updated ${repoLabel}. Re-index queued to apply file pattern changes.`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showWarningMessage(
            `Updated ${repoLabel}, but re-index could not be queued: ${message}`,
          );
        }
        return;
      }

      vscode.window.showInformationMessage(`Updated ${repoLabel}.`);
    }),

    vscode.commands.registerCommand('yoink.exportConfig', async () => {
      await workspaceConfigManager.exportConfig();
    }),

    vscode.commands.registerCommand('yoink.importConfig', async () => {
      await workspaceConfigManager.importFromWorkspace();
    }),

    vscode.commands.registerCommand('yoink.installAgents', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage('Yoink: Open a workspace folder first to install agents.');
        return;
      }
      try {
        const count = await agentInstaller.install(folder.uri);
        vscode.window.showInformationMessage(
          `Yoink: Installed ${count} agent file${count !== 1 ? 's' : ''} to .copilot/agents/`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Yoink: Failed to install agents — ${message}`);
      }
    }),
  );
}

function getCurrentDataSource(
  configManager: ConfigManager,
  item: DataSourceTreeItem,
): DataSourceConfig | undefined {
  const ds = configManager.getDataSource(item.dataSource.id);
  if (!ds) {
    vscode.window.showInformationMessage('Data source is no longer configured.');
    return undefined;
  }
  return ds;
}

function formatDataSourceLabel(ds: Pick<DataSourceConfig, 'owner' | 'repo'>): string {
  return `${ds.owner}/${ds.repo}`;
}

function samePatterns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((pattern, index) => pattern === b[index]);
}

async function removeDataSourceWithFeedback(
  dataSourceManager: DataSourceManager,
  id: string,
  label: string,
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Removing ${label}...`,
        cancellable: false,
      },
      () => dataSourceManager.remove(id),
    );
    vscode.window.showInformationMessage(`Removed ${label}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Yoink: Failed to remove ${label}: ${message}`);
  }
}
