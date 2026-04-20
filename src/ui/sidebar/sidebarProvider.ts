import * as vscode from 'vscode';
import { ConfigManager } from '../../config/configManager';
import {
  SidebarTreeItem,
  DataSourceTreeItem,
  DataSourceInfoItem,
  DataSourceFileItem,
  EmbeddingTreeItem,
} from './sidebarTreeItems';
import { EmbeddingProviderRegistry } from '../../embedding/registry';
import { SETTING_KEYS } from '../../config/settingsSchema';
import { ChunkStore } from '../../storage/chunkStore';
import { ProgressTracker } from '../../ingestion/progressTracker';

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
    const config = vscode.workspace.getConfiguration();
    const providerType = config.get<string>(SETTING_KEYS.EMBEDDING_PROVIDER, 'openai');

    if (providerType === 'azure-openai') {
      const deployment = config.get<string>(SETTING_KEYS.AZURE_DEPLOYMENT_NAME, '');
      const hasKey = await this.embeddingRegistry.hasAzureApiKey();
      return [new EmbeddingTreeItem(deployment || 'Azure OpenAI', hasKey, 'azure-openai')];
    } else if (providerType === 'local') {
      const model = config.get<string>(SETTING_KEYS.LOCAL_MODEL, 'local');
      return [new EmbeddingTreeItem(model, true, 'local')];
    } else {
      const model = config.get<string>(SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small');
      const hasKey = await this.embeddingRegistry.hasApiKey();
      return [new EmbeddingTreeItem(model, hasKey, 'openai')];
    }
  }

  dispose(): void {
    this.secretsListener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

