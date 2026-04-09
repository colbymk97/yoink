import * as vscode from 'vscode';
import { DataSourceConfig, ToolConfig } from '../../config/configSchema';
import { ConfigManager } from '../../config/configManager';

export type SidebarTreeItem = DataSourceTreeItem | ToolTreeItem | EmbeddingTreeItem;

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
      vscode.TreeItemCollapsibleState.None,
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

export class EmbeddingTreeItem extends vscode.TreeItem {
  constructor(model: string, hasKey: boolean) {
    super(model, vscode.TreeItemCollapsibleState.None);
    if (hasKey) {
      this.description = '$(check) API key configured';
      this.iconPath = new vscode.ThemeIcon('symbol-misc');
      this.tooltip = `Embedding model: ${model}\nAPI key: configured`;
    } else {
      this.description = '$(warning) No API key — click to set';
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      this.tooltip = `Embedding model: ${model}\nAPI key: not configured\nClick to set your OpenAI API key`;
      this.command = {
        command: 'repoLens.setApiKey',
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
