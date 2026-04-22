import * as vscode from 'vscode';
import { AddRepoWizard } from './wizard/addRepoWizard';
import { DataSourceManager } from '../sources/dataSourceManager';
import { EmbeddingProviderRegistry } from '../embedding/registry';
import { ConfigManager } from '../config/configManager';
import { WorkspaceConfigManager } from '../config/workspaceConfig';
import { DataSourceTreeItem } from './sidebar/sidebarTreeItems';
import { AgentInstaller } from '../agents/agentInstaller';
import { EmbeddingManager } from '../embedding/manager';

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
      const dataSources = configManager.getDataSources();
      if (dataSources.length === 0) {
        vscode.window.showInformationMessage('No data sources configured.');
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
        await dataSourceManager.remove(picked.id);
        vscode.window.showInformationMessage(`Removed ${picked.label}.`);
      }
    }),

    vscode.commands.registerCommand('yoink.syncDataSource', async () => {
      const dataSources = configManager.getDataSources();
      if (dataSources.length === 0) {
        vscode.window.showInformationMessage('No data sources configured.');
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
      await dataSourceManager.sync(item.dataSource.id);
      vscode.window.showInformationMessage(
        `Sync queued for ${item.dataSource.owner}/${item.dataSource.repo}.`,
      );
    }),

    vscode.commands.registerCommand('yoink.removeDataSourceFromTree', async (item: DataSourceTreeItem) => {
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${item.dataSource.owner}/${item.dataSource.repo}? This will delete all indexed data.`,
        { modal: true },
        'Remove',
      );
      if (confirm === 'Remove') {
        await dataSourceManager.remove(item.dataSource.id);
        vscode.window.showInformationMessage(
          `Removed ${item.dataSource.owner}/${item.dataSource.repo}.`,
        );
      }
    }),

    vscode.commands.registerCommand('yoink.editDataSourceFromTree', async (item: DataSourceTreeItem) => {
      const ds = item.dataSource;
      const repoLabel = `${ds.owner}/${ds.repo}`;

      const description = await vscode.window.showInputBox({
        title: `Edit ${repoLabel} (1/3)`,
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
        title: `Edit ${repoLabel} (2/3)`,
        placeHolder: 'Sync schedule',
        ignoreFocusOut: true,
      });
      if (!schedulePick) return;

      const includeInput = await vscode.window.showInputBox({
        title: `Edit ${repoLabel} (3/3)`,
        prompt: 'Include patterns (comma-separated globs, leave empty for all files)',
        value: ds.includePatterns.join(', '),
        ignoreFocusOut: true,
      });
      if (includeInput === undefined) return;

      const includePatterns = includeInput
        ? includeInput.split(',').map((p) => p.trim()).filter(Boolean)
        : [];

      configManager.updateDataSource(ds.id, {
        description: description || undefined,
        syncSchedule: schedulePick.value,
        includePatterns,
      });
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
