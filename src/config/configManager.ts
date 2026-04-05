import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  RepoLensConfig,
  DataSourceConfig,
  ToolConfig,
  createDefaultConfig,
} from './configSchema';

export class ConfigManager implements vscode.Disposable {
  private config: RepoLensConfig;
  private readonly configPath: string;
  private readonly _onDidChange = new vscode.EventEmitter<RepoLensConfig>();
  readonly onDidChange = this._onDidChange.event;

  constructor(globalStorageUri: vscode.Uri) {
    this.configPath = path.join(globalStorageUri.fsPath, 'repolens.json');
    this.config = this.load();
  }

  private load(): RepoLensConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(raw) as RepoLensConfig;
    } catch {
      return createDefaultConfig();
    }
  }

  private save(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
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
    this._onDidChange.dispose();
  }
}
