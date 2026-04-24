import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConfigManager } from '../config/configManager';
import { DataSourceConfig } from '../config/configSchema';
import { DataSourceType } from '../config/repoTypePresets';
import { IngestionPipeline } from '../ingestion/pipeline';
import { EmbeddingManager } from '../embedding/manager';

export interface AddDataSourceOptions {
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  type: DataSourceType;
  description?: string;
  includePatterns: string[];
  excludePatterns: string[];
  syncSchedule: 'manual' | 'onStartup' | 'daily';
}

export class DataSourceManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly pipeline: IngestionPipeline,
    private readonly embeddingManager: EmbeddingManager,
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
    const ds = this.configManager.getDataSource(id);
    if (!ds || ds.status === 'deleting') {
      return;
    }
    await this.assertApiKeyConfigured();
    this.configManager.updateDataSource(id, { status: 'queued' });
    this.pipeline.enqueue(id);
  }

  private async assertApiKeyConfigured(): Promise<void> {
    const ready = await this.embeddingManager.ensureConfigured();
    if (!ready) {
      throw new Error('Embedding provider is not configured.');
    }
  }

  async syncAll(): Promise<void> {
    for (const ds of this.configManager.getDataSources()) {
      if (ds.status === 'deleting') continue;
      await this.sync(ds.id);
    }
  }

  async remove(id: string): Promise<void> {
    const ds = this.configManager.getDataSource(id);
    if (!ds || ds.status === 'deleting') {
      return;
    }

    this.configManager.updateDataSource(id, {
      status: 'deleting',
      errorMessage: undefined,
    });
    this.configManager.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    try {
      await this.pipeline.removeDataSource(id);
      this.configManager.removeDataSource(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.configManager.updateDataSource(id, {
        status: 'error',
        errorMessage: `Delete failed: ${message}`,
      });
      this.configManager.flush();
      throw err;
    }
  }

  recoverInterruptedDeletions(): void {
    let recovered = false;
    for (const ds of this.configManager.getDataSources()) {
      if (ds.status !== 'deleting') continue;
      this.configManager.updateDataSource(ds.id, {
        status: 'error',
        errorMessage: 'Deletion was interrupted. Remove again to retry.',
      });
      recovered = true;
    }
    if (recovered) {
      this.configManager.flush();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
