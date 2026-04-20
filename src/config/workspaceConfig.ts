import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from './configManager';
import {
  ShareableConfig,
  ShareableDataSource,
  DEFAULT_EXCLUDE_PATTERNS,
} from './configSchema';
import { DataSourceManager } from '../sources/dataSourceManager';
import { Logger } from '../util/logger';

const WORKSPACE_CONFIG_FILENAME = 'yoink.json';
const WORKSPACE_CONFIG_DIR = '.vscode';

export interface ImportResult {
  dataSourcesAdded: number;
  dataSourcesSkipped: number;
  warnings: string[];
}

export class WorkspaceConfigManager {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly dataSourceManager: DataSourceManager,
    private readonly logger: Logger,
  ) {}

  /**
   * Detect .vscode/yoink.json in the primary workspace folder
   * and prompt the user to import it.
   */
  async detectAndPrompt(): Promise<void> {
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath) return;

    if (!fs.existsSync(configPath)) return;

    const shareable = this.readShareableConfig(configPath);
    if (!shareable) return;

    if (shareable.dataSources.length === 0) return;

    const action = await vscode.window.showInformationMessage(
      'Yoink config found in this workspace. Import data sources?',
      'Import',
      'Not Now',
    );

    if (action === 'Import') {
      const result = await this.importConfig(shareable);
      this.showImportSummary(result);
    }
  }

  /**
   * Export current config to .vscode/yoink.json in the primary workspace folder.
   */
  async exportConfig(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage(
        'Open a workspace folder first to export Yoink config.',
      );
      return;
    }

    const targetDir = path.join(workspaceFolder.uri.fsPath, WORKSPACE_CONFIG_DIR);
    const targetPath = path.join(targetDir, WORKSPACE_CONFIG_FILENAME);

    if (fs.existsSync(targetPath)) {
      const overwrite = await vscode.window.showWarningMessage(
        'Overwrite existing .vscode/yoink.json?',
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
      `Exported ${shareable.dataSources.length} data source${shareable.dataSources.length !== 1 ? 's' : ''} to .vscode/yoink.json`,
    );
    this.logger.info(`Exported config to ${targetPath}`);
  }

  /**
   * Import from .vscode/yoink.json in the primary workspace folder (manual command).
   */
  async importFromWorkspace(): Promise<void> {
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath) {
      vscode.window.showErrorMessage(
        'Open a workspace folder first to import Yoink config.',
      );
      return;
    }

    if (!fs.existsSync(configPath)) {
      vscode.window.showInformationMessage(
        'No .vscode/yoink.json found in this workspace.',
      );
      return;
    }

    const shareable = this.readShareableConfig(configPath);
    if (!shareable) {
      vscode.window.showErrorMessage(
        'Failed to parse .vscode/yoink.json. Check the file format.',
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
      warnings: [],
    };

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
          type: sds.type ?? 'general',
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
        type: ds.type,
        includePatterns: ds.includePatterns,
        excludePatterns: ds.excludePatterns,
        syncSchedule: ds.syncSchedule,
      }));

    const shareable: ShareableConfig = {
      $schema: 'https://yoink.dev/schema/shareable-config.json',
      version: 1,
      dataSources,
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
      if (!parsed.version || !Array.isArray(parsed.dataSources)) {
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
    const { dataSourcesAdded, dataSourcesSkipped } = result;

    if (dataSourcesAdded === 0 && dataSourcesSkipped > 0) {
      vscode.window.showInformationMessage(
        `Yoink: All ${dataSourcesSkipped} data source${dataSourcesSkipped !== 1 ? 's' : ''} already exist. Nothing to import.`,
      );
      return;
    }

    let message = dataSourcesAdded > 0
      ? `Yoink: Imported ${dataSourcesAdded} data source${dataSourcesAdded !== 1 ? 's' : ''}`
      : 'Yoink: Nothing to import.';

    if (dataSourcesSkipped > 0) {
      message += ` (${dataSourcesSkipped} already existed)`;
    }
    message += '.';

    if (result.warnings.length > 0) {
      vscode.window.showWarningMessage(
        `${message} ${result.warnings.length} warning(s) — check the Yoink output log.`,
      );
    } else {
      vscode.window.showInformationMessage(message);
    }
  }
}
