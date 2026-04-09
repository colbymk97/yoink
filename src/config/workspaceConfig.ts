import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigManager } from './configManager';
import {
  ShareableConfig,
  ShareableDataSource,
  ShareableTool,
  DEFAULT_EXCLUDE_PATTERNS,
} from './configSchema';
import { DataSourceManager } from '../sources/dataSourceManager';
import { Logger } from '../util/logger';

const WORKSPACE_CONFIG_FILENAME = 'repolens.json';
const WORKSPACE_CONFIG_DIR = '.vscode';

export interface ImportResult {
  dataSourcesAdded: number;
  dataSourcesSkipped: number;
  toolsAdded: number;
  toolsSkipped: number;
  warnings: string[];
}

export class WorkspaceConfigManager {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly dataSourceManager: DataSourceManager,
    private readonly logger: Logger,
  ) {}

  /**
   * Detect .vscode/repolens.json in the primary workspace folder
   * and prompt the user to import it.
   */
  async detectAndPrompt(): Promise<void> {
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath) return;

    if (!fs.existsSync(configPath)) return;

    const shareable = this.readShareableConfig(configPath);
    if (!shareable) return;

    if (shareable.dataSources.length === 0 && shareable.tools.length === 0) return;

    const action = await vscode.window.showInformationMessage(
      'RepoLens config found in this workspace. Import tools and data sources?',
      'Import',
      'Not Now',
    );

    if (action === 'Import') {
      const result = await this.importConfig(shareable);
      this.showImportSummary(result);
    }
  }

  /**
   * Export current config to .vscode/repolens.json in the primary workspace folder.
   */
  async exportConfig(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage(
        'Open a workspace folder first to export RepoLens config.',
      );
      return;
    }

    const targetDir = path.join(workspaceFolder.uri.fsPath, WORKSPACE_CONFIG_DIR);
    const targetPath = path.join(targetDir, WORKSPACE_CONFIG_FILENAME);

    if (fs.existsSync(targetPath)) {
      const overwrite = await vscode.window.showWarningMessage(
        'Overwrite existing .vscode/repolens.json?',
        { modal: true },
        'Overwrite',
      );
      if (overwrite !== 'Overwrite') return;
    }

    const shareable = this.buildShareableConfig();

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(targetPath, JSON.stringify(shareable, null, 2));

    vscode.window.showInformationMessage(
      `Exported ${shareable.dataSources.length} data sources and ${shareable.tools.length} tools to .vscode/repolens.json`,
    );
    this.logger.info(`Exported config to ${targetPath}`);
  }

  /**
   * Import from .vscode/repolens.json in the primary workspace folder (manual command).
   */
  async importFromWorkspace(): Promise<void> {
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath) {
      vscode.window.showErrorMessage(
        'Open a workspace folder first to import RepoLens config.',
      );
      return;
    }

    if (!fs.existsSync(configPath)) {
      vscode.window.showInformationMessage(
        'No .vscode/repolens.json found in this workspace.',
      );
      return;
    }

    const shareable = this.readShareableConfig(configPath);
    if (!shareable) {
      vscode.window.showErrorMessage(
        'Failed to parse .vscode/repolens.json. Check the file format.',
      );
      return;
    }

    const result = await this.importConfig(shareable);
    this.showImportSummary(result);
  }

  /**
   * Idempotent import: adds what's missing, skips what already exists.
   */
  async importConfig(shareable: ShareableConfig): Promise<ImportResult> {
    const result: ImportResult = {
      dataSourcesAdded: 0,
      dataSourcesSkipped: 0,
      toolsAdded: 0,
      toolsSkipped: 0,
      warnings: [],
    };

    // 1. Import data sources first
    for (const sds of shareable.dataSources) {
      if (this.dataSourceManager.isDuplicate(sds.owner, sds.repo, sds.branch)) {
        result.dataSourcesSkipped++;
        this.logger.info(`Skipped duplicate data source: ${sds.owner}/${sds.repo}@${sds.branch}`);
        continue;
      }

      try {
        await this.dataSourceManager.add({
          repoUrl: sds.repoUrl,
          owner: sds.owner,
          repo: sds.repo,
          branch: sds.branch,
          includePatterns: sds.includePatterns,
          excludePatterns: sds.excludePatterns,
          syncSchedule: sds.syncSchedule,
        });
        result.dataSourcesAdded++;
        this.logger.info(`Imported data source: ${sds.owner}/${sds.repo}@${sds.branch}`);
      } catch (err) {
        const msg = `Failed to import ${sds.owner}/${sds.repo}: ${err instanceof Error ? err.message : String(err)}`;
        result.warnings.push(msg);
        this.logger.warn(msg);
      }
    }

    // 2. Import tools (data sources are now available for reference resolution)
    for (const stool of shareable.tools) {
      const existingTool = this.configManager.getTools().find(
        (t) => t.name === stool.name,
      );
      if (existingTool) {
        result.toolsSkipped++;
        this.logger.info(`Skipped duplicate tool: ${stool.name}`);
        continue;
      }

      const resolvedIds = this.resolveDataSourceRefs(stool.dataSources, result.warnings);

      this.configManager.addTool({
        id: crypto.randomUUID(),
        name: stool.name,
        description: stool.description,
        dataSourceIds: resolvedIds,
      });
      result.toolsAdded++;
      this.logger.info(`Imported tool: ${stool.name}`);
    }

    this.configManager.flush();
    return result;
  }

  /**
   * Build a ShareableConfig from the current global config.
   */
  buildShareableConfig(): ShareableConfig {
    const dataSources: ShareableDataSource[] = this.configManager
      .getDataSources()
      .map((ds) => ({
        repoUrl: ds.repoUrl,
        owner: ds.owner,
        repo: ds.repo,
        branch: ds.branch,
        includePatterns: ds.includePatterns,
        excludePatterns: ds.excludePatterns,
        syncSchedule: ds.syncSchedule,
      }));

    const tools: ShareableTool[] = this.configManager.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      dataSources: tool.dataSourceIds
        .map((id) => {
          const ds = this.configManager.getDataSource(id);
          return ds ? `${ds.owner}/${ds.repo}@${ds.branch}` : null;
        })
        .filter((ref): ref is string => ref !== null),
    }));

    const shareable: ShareableConfig = {
      $schema: 'https://repolens.dev/schema/shareable-config.json',
      version: 1,
      dataSources,
      tools,
    };

    // Only include defaultExcludePatterns if they differ from built-in defaults
    const currentPatterns = this.configManager.getDefaultExcludePatterns();
    const defaultSet = new Set(DEFAULT_EXCLUDE_PATTERNS);
    const isCustomized =
      currentPatterns.length !== DEFAULT_EXCLUDE_PATTERNS.length ||
      currentPatterns.some((p) => !defaultSet.has(p));

    if (isCustomized) {
      shareable.defaultExcludePatterns = currentPatterns;
    }

    return shareable;
  }

  private resolveDataSourceRefs(refs: string[], warnings: string[]): string[] {
    const ids: string[] = [];
    for (const ref of refs) {
      const match = ref.match(/^(.+?)\/(.+?)@(.+)$/);
      if (!match) {
        warnings.push(`Invalid data source reference: "${ref}"`);
        continue;
      }
      const [, owner, repo, branch] = match;
      const ds = this.configManager.getDataSources().find(
        (d) =>
          d.owner.toLowerCase() === owner.toLowerCase() &&
          d.repo.toLowerCase() === repo.toLowerCase() &&
          d.branch === branch,
      );
      if (ds) {
        ids.push(ds.id);
      } else {
        warnings.push(`Could not resolve data source reference: "${ref}"`);
      }
    }
    return ids;
  }

  private getWorkspaceConfigPath(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return path.join(folder.uri.fsPath, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_FILENAME);
  }

  private readShareableConfig(filePath: string): ShareableConfig | undefined {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ShareableConfig;
      if (!parsed.version || !Array.isArray(parsed.dataSources) || !Array.isArray(parsed.tools)) {
        this.logger.warn(`Invalid shareable config at ${filePath}`);
        return undefined;
      }
      return parsed;
    } catch (err) {
      this.logger.warn(`Failed to read shareable config: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private showImportSummary(result: ImportResult): void {
    const parts: string[] = [];
    if (result.dataSourcesAdded > 0) {
      parts.push(`${result.dataSourcesAdded} data source${result.dataSourcesAdded !== 1 ? 's' : ''}`);
    }
    if (result.toolsAdded > 0) {
      parts.push(`${result.toolsAdded} tool${result.toolsAdded !== 1 ? 's' : ''}`);
    }

    const skipped = result.dataSourcesSkipped + result.toolsSkipped;

    if (parts.length === 0 && skipped > 0) {
      vscode.window.showInformationMessage(
        `RepoLens: All ${skipped} items already exist. Nothing to import.`,
      );
      return;
    }

    let message = `RepoLens: Imported ${parts.join(' and ')}`;
    if (skipped > 0) {
      message += ` (${skipped} already existed)`;
    }
    message += '.';

    if (result.warnings.length > 0) {
      vscode.window.showWarningMessage(
        `${message} ${result.warnings.length} warning(s) — check the RepoLens output log.`,
      );
    } else {
      vscode.window.showInformationMessage(message);
    }
  }
}
