import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  RepoLensConfig,
  DataSourceConfig,
  ToolConfig,
  createDefaultConfig,
} from './configSchema';

const DEBOUNCE_MS = 300;

export class ConfigManager implements vscode.Disposable {
  private config: RepoLensConfig;
  private readonly configPath: string;
  private readonly _onDidChange = new vscode.EventEmitter<RepoLensConfig>();
  readonly onDidChange = this._onDidChange.event;

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private suppressNextFileEvent = false;

  constructor(globalStorageUri: vscode.Uri) {
    this.configPath = path.join(globalStorageUri.fsPath, 'repolens.json');
    this.config = this.load();
    this.setupFileWatcher();
  }

  private load(): RepoLensConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(raw) as RepoLensConfig;
    } catch {
      // If the file exists but is corrupt, back it up
      if (fs.existsSync(this.configPath)) {
        const backupPath = this.configPath + '.bak';
        try {
          fs.copyFileSync(this.configPath, backupPath);
        } catch {
          // Best-effort backup
        }
      }
      return createDefaultConfig();
    }
  }

  private saveImmediate(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.suppressNextFileEvent = true;
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    this._onDidChange.fire(this.config);
  }

  private save(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.saveImmediate();
    }, DEBOUNCE_MS);
  }

  /**
   * Flush any pending debounced writes immediately.
   */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
      this.saveImmediate();
    }
  }

  private setupFileWatcher(): void {
    try {
      const pattern = new vscode.RelativePattern(
        path.dirname(this.configPath),
        path.basename(this.configPath),
      );
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.fileWatcher.onDidChange(() => this.onFileChanged());
      this.fileWatcher.onDidCreate(() => this.onFileChanged());
    } catch {
      // File watcher may not be available in all environments
    }
  }

  private onFileChanged(): void {
    if (this.suppressNextFileEvent) {
      this.suppressNextFileEvent = false;
      return;
    }
    const reloaded = this.load();
    this.config = reloaded;
    this._onDidChange.fire(this.config);
  }

  getConfig(): Readonly<RepoLensConfig> {
    return this.config;
  }

  getDataSource(id: string): DataSourceConfig | undefined {
    return this.config.dataSources.find((ds) => ds.id === id);
  }

  getDataSources(): readonly DataSourceConfig[] {
    return this.config.dataSources;
  }

  getDefaultExcludePatterns(): string[] {
    return this.config.defaultExcludePatterns;
  }

  addDataSource(ds: DataSourceConfig): void {
    this.config.dataSources.push(ds);
    this.save();
  }

  updateDataSource(id: string, updates: Partial<DataSourceConfig>): void {
    const ds = this.config.dataSources.find((d) => d.id === id);
    if (ds) {
      Object.assign(ds, updates);
      this.save();
    }
  }

  removeDataSource(id: string): void {
    this.config.dataSources = this.config.dataSources.filter((d) => d.id !== id);
    this.config.tools = this.config.tools.map((t) => ({
      ...t,
      dataSourceIds: t.dataSourceIds.filter((dsId) => dsId !== id),
    }));
    this.save();
  }

  getTool(id: string): ToolConfig | undefined {
    return this.config.tools.find((t) => t.id === id);
  }

  getTools(): readonly ToolConfig[] {
    return this.config.tools;
  }

  addTool(tool: ToolConfig): void {
    this.config.tools.push(tool);
    this.save();
  }

  updateTool(id: string, updates: Partial<ToolConfig>): void {
    const tool = this.config.tools.find((t) => t.id === id);
    if (tool) {
      Object.assign(tool, updates);
      this.save();
    }
  }

  removeTool(id: string): void {
    this.config.tools = this.config.tools.filter((t) => t.id !== id);
    this.save();
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.fileWatcher?.dispose();
    this._onDidChange.dispose();
  }
}
