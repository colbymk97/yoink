import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConfigManager } from '../config/configManager';
import { DataSourceConfig } from '../config/configSchema';
import { IngestionPipeline } from '../ingestion/pipeline';

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
  ) {}

  async add(options: AddDataSourceOptions): Promise<DataSourceConfig> {
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
    this.configManager.updateDataSource(id, { status: 'queued' });
    this.pipeline.enqueue(id);
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
