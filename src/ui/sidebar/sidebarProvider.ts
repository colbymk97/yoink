import * as vscode from 'vscode';
import { ConfigManager } from '../../config/configManager';
import { SidebarTreeItem, DataSourceTreeItem, ToolTreeItem } from './sidebarTreeItems';

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
