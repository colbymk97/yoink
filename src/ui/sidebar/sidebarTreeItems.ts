import * as vscode from 'vscode';
import { DataSourceConfig } from '../../config/configSchema';
import { DataSourceStats, FileStats } from '../../storage/chunkStore';
import { IndexingProgress } from '../../ingestion/progressTracker';
import { getPricingForModel, formatCost } from '../../embedding/pricing';
import { EmbeddingStatus } from '../../embedding/manager';

export type SidebarTreeItem =
  | DataSourceTreeItem
  | DataSourceInfoItem
  | DataSourceFileItem
  | EmbeddingTreeItem;

const STATUS_ICONS: Record<string, string> = {
  queued: '$(clock)',
  indexing: '$(sync~spin)',
  ready: '$(check)',
  error: '$(error)',
  deleting: '$(sync~spin)',
};

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export class DataSourceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly dataSource: DataSourceConfig,
    private readonly progress?: IndexingProgress,
    private readonly stats?: DataSourceStats,
  ) {
    super(
      `${dataSource.owner}/${dataSource.repo}`,
      isExpandable(dataSource, stats)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    if (dataSource.status === 'deleting') {
      this.description = '$(sync~spin) Deleting...';
    } else if (dataSource.status === 'indexing' && progress) {
      const filesText = `${progress.processedFiles}/${progress.totalFiles} files`;
      const tokensText = `${formatNumber(progress.totalTokens)} tokens`;
      const partialText = (stats?.fileCount ?? 0) > 0 ? ' · partial' : '';
      this.description = `$(sync~spin) ${filesText} · ${tokensText}${partialText}`;
    } else {
      const icon = STATUS_ICONS[dataSource.status] || '$(question)';
      const partialText = dataSource.status !== 'ready' && (stats?.fileCount ?? 0) > 0
        ? ' · partial'
        : '';
      this.description = `${icon} ${dataSource.branch}${partialText}`;
    }

    this.tooltip = this.buildTooltip();
    this.contextValue = dataSource.status === 'deleting' ? 'dataSourceDeleting' : 'dataSource';

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
    ];
    if (this.dataSource.description) {
      lines.push(this.dataSource.description);
    }
    lines.push(`Status: ${formatStatus(this.dataSource.status)}`);
    if (this.dataSource.lastSyncedAt) {
      lines.push(`Last synced: ${this.dataSource.lastSyncedAt}`);
    }
    if (this.stats && this.stats.fileCount > 0) {
      lines.push(
        `Indexed so far: ${formatNumber(this.stats.fileCount)} files, ${formatNumber(this.stats.chunkCount)} chunks, ${formatNumber(this.stats.totalTokens)} tokens`,
      );
    }
    if (this.dataSource.errorMessage) {
      lines.push(`Error: ${this.dataSource.errorMessage}`);
    }
    return lines.join('\n');
  }
}

export class DataSourceInfoItem extends vscode.TreeItem {
  constructor(stats: DataSourceStats, dataSource: DataSourceConfig, embeddingModel?: string) {
    const partialLabel = dataSource.status === 'ready' ? '' : ' · partial';
    const label = `${formatNumber(stats.fileCount)} files · ${formatNumber(stats.chunkCount)} chunks · ${formatNumber(stats.totalTokens)} tokens${partialLabel}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'dataSourceInfo';

    const lines = [
      `${dataSource.owner}/${dataSource.repo}@${dataSource.branch}`,
      `Files: ${formatNumber(stats.fileCount)}`,
      `Chunks: ${formatNumber(stats.chunkCount)}`,
      `Tokens: ${formatNumber(stats.totalTokens)}`,
    ];
    if (embeddingModel) {
      const { costPerToken } = getPricingForModel(embeddingModel);
      const costStr = formatCost(stats.totalTokens, costPerToken);
      if (costStr) {
        lines.push(`Est. indexing cost: ${costStr}`);
      }
    }
    if (dataSource.lastSyncedAt) {
      lines.push(`Last synced: ${dataSource.lastSyncedAt}`);
    }
    if (dataSource.lastSyncCommitSha) {
      lines.push(`Commit: ${dataSource.lastSyncCommitSha.slice(0, 7)}`);
    }
    this.tooltip = lines.join('\n');
  }
}

function isExpandable(dataSource: DataSourceConfig, stats?: DataSourceStats): boolean {
  if (dataSource.status === 'deleting') return false;
  return dataSource.status === 'ready' || (stats?.fileCount ?? 0) > 0;
}

function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
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
  constructor(status: EmbeddingStatus) {
    super(`${status.providerLabel}: ${status.identifier}`, vscode.TreeItemCollapsibleState.None);

    this.description = status.isRebuilding
      ? '$(sync~spin) Rebuilding…'
      : status.isStale
        ? '$(warning) Rebuild required'
        : status.isConfigured
          ? '$(check) Configured'
          : '$(warning) Setup required';
    this.tooltip = status.tooltip;
    this.contextValue = status.isStale ? 'embeddingStale' : (status.isConfigured ? 'embeddingReady' : 'embeddingNeedsSetup');
    this.command = {
      command: status.actionCommand,
      title: status.actionCommand === 'yoink.rebuildEmbeddings' ? 'Rebuild Embeddings' : 'Manage Embeddings',
    };

    if (status.isRebuilding) {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    } else if (status.isStale || !status.isConfigured) {
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('problemsWarningIcon.foreground'),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon('symbol-misc');
    }
  }
}
