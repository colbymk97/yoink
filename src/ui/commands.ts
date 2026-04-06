import * as vscode from 'vscode';
import { AddRepoWizard } from './wizard/addRepoWizard';
import { DataSourceManager } from '../sources/dataSourceManager';
import { EmbeddingProviderRegistry } from '../embedding/registry';
import { ConfigManager } from '../config/configManager';
import { DataSourceTreeItem, ToolTreeItem } from './sidebar/sidebarTreeItems';

export function registerCommands(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  dataSourceManager: DataSourceManager,
  providerRegistry: EmbeddingProviderRegistry,
  wizardFactory: () => AddRepoWizard,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repoLens.addRepository', async () => {
      const wizard = wizardFactory();
      await wizard.run();
    }),

    vscode.commands.registerCommand('repoLens.removeRepository', async () => {
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

    vscode.commands.registerCommand('repoLens.syncDataSource', async () => {
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

    vscode.commands.registerCommand('repoLens.syncAllDataSources', async () => {
      await dataSourceManager.syncAll();
      vscode.window.showInformationMessage('Sync queued for all data sources.');
    }),

    vscode.commands.registerCommand('repoLens.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI API key',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.startsWith('sk-') ? null : 'API key should start with sk-'),
      });
      if (key) {
        await providerRegistry.setApiKey(key);
        vscode.window.showInformationMessage('OpenAI API key saved.');
      }
    }),

    // Tree-item context menu commands
    vscode.commands.registerCommand('repoLens.syncDataSourceFromTree', async (item: DataSourceTreeItem) => {
      await dataSourceManager.sync(item.dataSource.id);
      vscode.window.showInformationMessage(
        `Sync queued for ${item.dataSource.owner}/${item.dataSource.repo}.`,
      );
    }),

    vscode.commands.registerCommand('repoLens.removeDataSourceFromTree', async (item: DataSourceTreeItem) => {
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

    vscode.commands.registerCommand('repoLens.editToolFromTree', async (item: ToolTreeItem) => {
      const newDescription = await vscode.window.showInputBox({
        prompt: 'Tool description',
        value: item.tool.description,
        ignoreFocusOut: true,
      });
      if (newDescription !== undefined) {
        configManager.updateTool(item.tool.id, { description: newDescription });
        vscode.window.showInformationMessage(`Updated tool "${item.tool.name}".`);
      }
    }),

    vscode.commands.registerCommand('repoLens.editTool', async () => {
      const tools = configManager.getTools();
      if (tools.length === 0) {
        vscode.window.showInformationMessage('No tools configured.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        tools.map((t) => ({ label: t.name, description: t.description, id: t.id })),
        { placeHolder: 'Select a tool to edit' },
      );
      if (!picked) return;

      const tool = configManager.getTool(picked.id);
      if (!tool) return;

      const newDescription = await vscode.window.showInputBox({
        prompt: 'Tool description',
        value: tool.description,
        ignoreFocusOut: true,
      });
      if (newDescription !== undefined) {
        configManager.updateTool(picked.id, { description: newDescription });
        vscode.window.showInformationMessage(`Updated tool "${tool.name}".`);
      }
    }),
  );
}
