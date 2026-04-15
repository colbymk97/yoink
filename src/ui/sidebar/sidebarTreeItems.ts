import * as vscode from 'vscode';
import { DataSourceConfig, ToolConfig } from '../../config/configSchema';
import { ConfigManager } from '../../config/configManager';
import { DataSourceStats, FileStats } from '../../storage/chunkStore';

export type SidebarTreeItem =
  | DataSourceTreeItem
  | DataSourceInfoItem
  | DataSourceFileItem
  | ToolTreeItem
  | EmbeddingTreeItem;

const STATUS_ICONS: Record<string, string> = {
  queued: '$(clock)',
  indexing: '$(sync~spin)',
  ready: '$(check)',
  error: '$(error)',
};

export class DataSourceTreeItem extends vscode.TreeItem {
  constructor(public readonly dataSource: DataSourceConfig) {
    super(
      `${dataSource.owner}/${dataSource.repo}`,
      dataSource.status === 'ready'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    const icon = STATUS_ICONS[dataSource.status] || '$(question)';
    this.description = `${icon} ${dataSource.branch}`;
    this.tooltip = this.buildTooltip();
    this.contextValue = 'dataSource';

    if (dataSource.status === 'error') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    } else if (dataSource.status === 'ready') {
      this.iconPath = new vscode.ThemeIcon('database');
    } else {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
  }

  private buildTooltip(): string {
    const lines = [
      `${this.dataSource.owner}/${this.dataSource.repo}@${this.dataSource.branch}`,
      `Status: ${this.dataSource.status}`,
    ];
    if (this.dataSource.lastSyncedAt) {
      lines.push(`Last synced: ${this.dataSource.lastSyncedAt}`);
    }
    if (this.dataSource.errorMessage) {
      lines.push(`Error: ${this.dataSource.errorMessage}`);
    }
    return lines.join('\n');
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export class DataSourceInfoItem extends vscode.TreeItem {
  constructor(stats: DataSourceStats, dataSource: DataSourceConfig) {
    const label = `${formatNumber(stats.fileCount)} files · ${formatNumber(stats.chunkCount)} chunks · ${formatNumber(stats.totalTokens)} tokens`;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'dataSourceInfo';

    const lines = [
      `${dataSource.owner}/${dataSource.repo}@${dataSource.branch}`,
      `Files: ${formatNumber(stats.fileCount)}`,
      `Chunks: ${formatNumber(stats.chunkCount)}`,
      `Tokens: ${formatNumber(stats.totalTokens)}`,
    ];
    if (dataSource.lastSyncedAt) {
      lines.push(`Last synced: ${dataSource.lastSyncedAt}`);
    }
    if (dataSource.lastSyncCommitSha) {
      lines.push(`Commit: ${dataSource.lastSyncCommitSha.slice(0, 7)}`);
    }
    this.tooltip = lines.join('\n');
  }
}

export class DataSourceFileItem extends vscode.TreeItem {
  constructor(fileStats: FileStats) {
    super(fileStats.filePath, vscode.TreeItemCollapsibleState.None);

    this.description = `${fileStats.chunkCount} chunk${fileStats.chunkCount !== 1 ? 's' : ''}`;
    this.iconPath = new vscode.ThemeIcon('file');
    this.contextValue = 'dataSourceFile';
    this.tooltip = `${fileStats.filePath}\n${fileStats.chunkCount} chunks · ${formatNumber(fileStats.tokenCount)} tokens`;
  }
}

export class EmbeddingTreeItem extends vscode.TreeItem {
  constructor(model: string, hasKey: boolean, provider: 'openai' | 'azure-openai' | 'local') {
    super(model, vscode.TreeItemCollapsibleState.None);

    if (provider === 'local') {
      this.description = '$(check) Local model';
      this.iconPath = new vscode.ThemeIcon('symbol-misc');
      this.tooltip = `Embedding model: ${model}\nLocal model (no API key required)`;
    } else if (hasKey) {
      this.description = '$(check) API key configured';
      this.iconPath = new vscode.ThemeIcon('symbol-misc');
      this.tooltip = `Embedding model: ${model}\nAPI key: configured`;
    } else {
      const setKeyCommand = provider === 'azure-openai' ? 'yoink.setAzureApiKey' : 'yoink.setApiKey';
      const providerLabel = provider === 'azure-openai' ? 'Azure OpenAI' : 'OpenAI';
      this.description = '$(warning) No API key — click to set';
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      this.tooltip = `Embedding model: ${model}\nAPI key: not configured\nClick to set your ${providerLabel} API key`;
      this.command = {
        command: setKeyCommand,
        title: 'Set API Key',
      };
    }
    this.contextValue = 'embedding';
  }
}

export class ToolTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tool: ToolConfig,
    private readonly configManager: ConfigManager,
  ) {
    super(tool.name, vscode.TreeItemCollapsibleState.None);

    const sourceCount = tool.dataSourceIds.length;
    const sourceLabels = tool.dataSourceIds
      .map((id) => {
        const ds = configManager.getDataSource(id);
        return ds ? `${ds.owner}/${ds.repo}` : 'unknown';
      })
      .join(', ');

    this.description = `${sourceCount} source${sourceCount !== 1 ? 's' : ''}`;
    this.tooltip = `${tool.name}\n${tool.description}\nSources: ${sourceLabels}`;
    this.contextValue = 'tool';
    this.iconPath = new vscode.ThemeIcon('tools');
  }
}
