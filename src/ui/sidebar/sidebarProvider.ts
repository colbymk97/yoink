import * as vscode from 'vscode';
import { ConfigManager } from '../../config/configManager';
import { SidebarTreeItem, DataSourceTreeItem, ToolTreeItem, EmbeddingTreeItem } from './sidebarTreeItems';
import { EmbeddingProviderRegistry } from '../../embedding/registry';
import { SETTING_KEYS } from '../../config/settingsSchema';

export class DataSourceTreeProvider
  implements vscode.TreeDataProvider<SidebarTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly configManager: ConfigManager) {
    configManager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SidebarTreeItem[] {
    return this.configManager.getDataSources().map(
      (ds) => new DataSourceTreeItem(ds),
    );
  }
}

export class EmbeddingTreeProvider implements vscode.TreeDataProvider<SidebarTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly secretsListener: vscode.Disposable;

  constructor(
    private readonly embeddingRegistry: EmbeddingProviderRegistry,
    secrets: vscode.SecretStorage,
  ) {
    this.secretsListener = secrets.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SidebarTreeItem[]> {
    const model = vscode.workspace
      .getConfiguration()
      .get<string>(SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small');
    const hasKey = await this.embeddingRegistry.hasApiKey();
    return [new EmbeddingTreeItem(model, hasKey)];
  }

  dispose(): void {
    this.secretsListener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

export class ToolTreeProvider implements vscode.TreeDataProvider<SidebarTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly configManager: ConfigManager) {
    configManager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SidebarTreeItem[] {
    return this.configManager.getTools().map(
      (tool) => new ToolTreeItem(tool, this.configManager),
    );
  }
}
