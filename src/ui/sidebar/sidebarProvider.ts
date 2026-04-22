import * as vscode from 'vscode';
import { ConfigManager } from '../../config/configManager';
import {
  SidebarTreeItem,
  DataSourceTreeItem,
  DataSourceInfoItem,
  DataSourceFileItem,
  EmbeddingTreeItem,
} from './sidebarTreeItems';
import { SETTING_KEYS } from '../../config/settingsSchema';
import { ChunkStore } from '../../storage/chunkStore';
import { ProgressTracker } from '../../ingestion/progressTracker';
import { EmbeddingManager } from '../../embedding/manager';

export class DataSourceTreeProvider
  implements vscode.TreeDataProvider<SidebarTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly chunkStore: ChunkStore,
    private readonly progressTracker: ProgressTracker,
  ) {
    configManager.onDidChange(() => this.refresh());
    progressTracker.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SidebarTreeItem): SidebarTreeItem[] {
    if (!element) {
      return this.configManager.getDataSources().map(
        (ds) => new DataSourceTreeItem(ds, this.progressTracker.get(ds.id)),
      );
    }

    if (element instanceof DataSourceTreeItem && element.dataSource.status === 'ready') {
      const dsId = element.dataSource.id;
      const stats = this.chunkStore.getDataSourceStats(dsId);
      const fileStats = this.chunkStore.getFileStats(dsId);
      const model = vscode.workspace.getConfiguration().get<string>(
        SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small',
      );

      return [
        new DataSourceInfoItem(stats, element.dataSource, model),
        ...fileStats.map((fs) => new DataSourceFileItem(fs)),
      ];
    }

    return [];
  }
}

export class EmbeddingTreeProvider implements vscode.TreeDataProvider<SidebarTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly managerListener: vscode.Disposable;

  constructor(
    private readonly embeddingManager: EmbeddingManager,
  ) {
    this.managerListener = embeddingManager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SidebarTreeItem[]> {
    return [new EmbeddingTreeItem(await this.embeddingManager.getStatus())];
  }

  dispose(): void {
    this.managerListener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
