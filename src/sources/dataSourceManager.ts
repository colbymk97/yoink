import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConfigManager } from '../config/configManager';
import { DataSourceConfig } from '../config/configSchema';
import { IngestionPipeline } from '../ingestion/pipeline';
import { EmbeddingProviderRegistry } from '../embedding/registry';

export interface AddDataSourceOptions {
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  includePatterns: string[];
  excludePatterns: string[];
  syncSchedule: 'manual' | 'onStartup' | 'daily';
}

export class DataSourceManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly pipeline: IngestionPipeline,
    private readonly embeddingRegistry: EmbeddingProviderRegistry,
  ) {}

  /**
   * Check if a data source with the same owner/repo/branch already exists.
   */
  isDuplicate(owner: string, repo: string, branch: string): boolean {
    return this.configManager.getDataSources().some(
      (ds) =>
        ds.owner.toLowerCase() === owner.toLowerCase() &&
        ds.repo.toLowerCase() === repo.toLowerCase() &&
        ds.branch === branch,
    );
  }

  async add(options: AddDataSourceOptions): Promise<DataSourceConfig> {
    if (this.isDuplicate(options.owner, options.repo, options.branch)) {
      throw new Error(
        `${options.owner}/${options.repo}@${options.branch} is already configured.`,
      );
    }

    await this.assertApiKeyConfigured();

    const ds: DataSourceConfig = {
      id: crypto.randomUUID(),
      ...options,
      lastSyncedAt: null,
      lastSyncCommitSha: null,
      status: 'queued',
    };
    this.configManager.addDataSource(ds);
    this.pipeline.enqueue(ds.id);
    return ds;
  }

  async sync(id: string): Promise<void> {
    await this.assertApiKeyConfigured();
    this.configManager.updateDataSource(id, { status: 'queued' });
    this.pipeline.enqueue(id);
  }

  private async assertApiKeyConfigured(): Promise<void> {
    try {
      await this.embeddingRegistry.getProvider();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const action = await vscode.window.showErrorMessage(
        `RepoLens: ${message}`,
        'Set API Key',
      );
      if (action === 'Set API Key') {
        await vscode.commands.executeCommand('repoLens.setApiKey');
      }
      throw err;
    }
  }

  async syncAll(): Promise<void> {
    for (const ds of this.configManager.getDataSources()) {
      await this.sync(ds.id);
    }
  }

  async remove(id: string): Promise<void> {
    await this.pipeline.removeDataSource(id);
    this.configManager.removeDataSource(id);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
