import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

vi.mock('fs');

import * as vscode from 'vscode';
import { WorkspaceConfigManager } from '../../../src/config/workspaceConfig';
import { ShareableConfig, DataSourceConfig } from '../../../src/config/configSchema';

function makeConfigManager(opts: {
  dataSources?: DataSourceConfig[];
} = {}) {
  const dataSources = opts.dataSources ?? [];

  return {
    getDataSources: vi.fn().mockReturnValue(dataSources),
    getDataSource: vi.fn((id: string) => dataSources.find((d) => d.id === id)),
    getDefaultExcludePatterns: vi.fn().mockReturnValue([]),
    getConfig: vi.fn().mockReturnValue({ defaultExcludePatterns: [] }),
    flush: vi.fn(),
  } as any;
}

function makeDataSourceManager(opts: { duplicates?: string[] } = {}) {
  const duplicates = opts.duplicates ?? [];
  return {
    isDuplicate: vi.fn((owner: string, repo: string, branch: string) =>
      duplicates.includes(`${owner}/${repo}@${branch}`),
    ),
    add: vi.fn().mockResolvedValue({ id: 'new-ds-id' }),
  } as any;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

function makeDs(owner: string, repo: string, branch = 'main', id = 'ds-1'): DataSourceConfig {
  return {
    id, repoUrl: `https://github.com/${owner}/${repo}`,
    owner, repo, branch,
    type: 'general',
    includePatterns: [], excludePatterns: [],
    syncSchedule: 'manual', lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
  };
}

const WORKSPACE_CONFIG_PATH = path.join('/workspace', '.vscode', 'yoink.json');

describe('WorkspaceConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  });

  describe('buildShareableConfig', () => {
    it('maps data sources to shareable format', () => {
      const ds = makeDs('acme', 'widgets');
      ds.includePatterns = ['src/**'];
      ds.excludePatterns = ['**/*.test.ts'];
      ds.syncSchedule = 'onStartup';

      const configManager = makeConfigManager({ dataSources: [ds] });
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const result = mgr.buildShareableConfig();

      expect(result.dataSources).toHaveLength(1);
      expect(result.dataSources[0]).toEqual({
        repoUrl: 'https://github.com/acme/widgets',
        owner: 'acme',
        repo: 'widgets',
        branch: 'main',
        type: 'general',
        includePatterns: ['src/**'],
        excludePatterns: ['**/*.test.ts'],
        syncSchedule: 'onStartup',
      });
      expect(result.dataSources[0]).not.toHaveProperty('id');
      expect(result.dataSources[0]).not.toHaveProperty('status');
      expect(result.dataSources[0]).not.toHaveProperty('lastSyncedAt');
    });

    it('does not include defaultExcludePatterns when they match defaults', () => {
      const configManager = makeConfigManager();
      configManager.getDefaultExcludePatterns.mockReturnValue([
        '**/node_modules/**', '**/dist/**',
      ]);
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const result = mgr.buildShareableConfig();

      expect(result).toHaveProperty('$schema');
      expect(result.version).toBe(1);
    });

    it('includes defaultExcludePatterns when they are customized', () => {
      const configManager = makeConfigManager();
      configManager.getDefaultExcludePatterns.mockReturnValue(['**/generated/**']);
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const result = mgr.buildShareableConfig();

      expect(result.defaultExcludePatterns).toEqual(['**/generated/**']);
    });
  });

  describe('importConfig', () => {
    it('adds new data sources', async () => {
      const configManager = makeConfigManager();
      const dsMgr = makeDataSourceManager();
      dsMgr.add.mockImplementation(async (opts: any) => {
        const ds = makeDs(opts.owner, opts.repo, opts.branch, 'new-ds-id');
        configManager.getDataSources.mockReturnValue([ds]);
        return ds;
      });

      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [{
          repoUrl: 'https://github.com/acme/widgets',
          owner: 'acme', repo: 'widgets', branch: 'main',
          includePatterns: [], excludePatterns: [],
          syncSchedule: 'manual',
        }],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.dataSourcesAdded).toBe(1);
      expect(result.dataSourcesSkipped).toBe(0);
      expect(dsMgr.add).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'acme', repo: 'widgets', branch: 'main',
      }));
    });

    it('skips duplicate data sources (idempotent)', async () => {
      const configManager = makeConfigManager();
      const dsMgr = makeDataSourceManager({ duplicates: ['acme/widgets@main'] });

      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [{
          repoUrl: 'https://github.com/acme/widgets',
          owner: 'acme', repo: 'widgets', branch: 'main',
          includePatterns: [], excludePatterns: [],
          syncSchedule: 'manual',
        }],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.dataSourcesAdded).toBe(0);
      expect(result.dataSourcesSkipped).toBe(1);
      expect(dsMgr.add).not.toHaveBeenCalled();
    });

    it('is fully idempotent on second run', async () => {
      const ds = makeDs('acme', 'widgets', 'main', 'existing-id');
      const configManager = makeConfigManager({ dataSources: [ds] });
      const dsMgr = makeDataSourceManager({ duplicates: ['acme/widgets@main'] });

      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [{
          repoUrl: 'https://github.com/acme/widgets',
          owner: 'acme', repo: 'widgets', branch: 'main',
          includePatterns: [], excludePatterns: [],
          syncSchedule: 'manual',
        }],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.dataSourcesAdded).toBe(0);
      expect(result.dataSourcesSkipped).toBe(1);
    });

    it('continues on data source add failure', async () => {
      const configManager = makeConfigManager();
      const dsMgr = makeDataSourceManager();
      dsMgr.add
        .mockRejectedValueOnce(new Error('API key missing'))
        .mockResolvedValueOnce(makeDs('other', 'lib', 'main', 'ds-2'));

      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [
          { repoUrl: 'https://github.com/acme/widgets', owner: 'acme', repo: 'widgets', branch: 'main', includePatterns: [], excludePatterns: [], syncSchedule: 'manual' },
          { repoUrl: 'https://github.com/other/lib', owner: 'other', repo: 'lib', branch: 'main', includePatterns: [], excludePatterns: [], syncSchedule: 'manual' },
        ],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.dataSourcesAdded).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('API key missing');
    });

    it('flushes config after import', async () => {
      const configManager = makeConfigManager();
      const dsMgr = makeDataSourceManager();

      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      await mgr.importConfig({ version: 1, dataSources: [] });

      expect(configManager.flush).toHaveBeenCalled();
    });

    it('defaults missing data source type to general', async () => {
      const configManager = makeConfigManager();
      const dsMgr = makeDataSourceManager();
      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      await mgr.importConfig({
        version: 1,
        dataSources: [{
          repoUrl: 'https://github.com/acme/widgets',
          owner: 'acme',
          repo: 'widgets',
          branch: 'main',
          includePatterns: ['src/**'],
          excludePatterns: [],
          syncSchedule: 'manual',
        }],
      });

      expect(dsMgr.add).toHaveBeenCalledWith(expect.objectContaining({
        type: 'general',
        includePatterns: ['src/**'],
      }));
    });
  });

  describe('exportConfig', () => {
    it('writes shareable config to .vscode/yoink.json', async () => {
      const ds = makeDs('acme', 'widgets');
      const configManager = makeConfigManager({ dataSources: [ds] });
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (fs.existsSync as any).mockReturnValue(false);
      (fs.writeFileSync as any).mockImplementation(() => {});
      (fs.mkdirSync as any).mockImplementation(() => {});

      await mgr.exportConfig();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        WORKSPACE_CONFIG_PATH,
        expect.stringContaining('"acme"'),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 data source'),
      );
    });

    it('prompts before overwriting existing file', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (fs.existsSync as any).mockReturnValue(true);
      (vscode.window.showWarningMessage as any).mockResolvedValue('Overwrite');
      (fs.writeFileSync as any).mockImplementation(() => {});

      await mgr.exportConfig();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Overwrite existing .vscode/yoink.json?',
        { modal: true },
        'Overwrite',
      );
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('does not overwrite when user cancels', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (fs.existsSync as any).mockReturnValue(true);
      (vscode.window.showWarningMessage as any).mockResolvedValue(undefined);

      await mgr.exportConfig();

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('shows error when no workspace is open', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (vscode.workspace as any).workspaceFolders = undefined;

      await mgr.exportConfig();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Open a workspace folder first to export Yoink config.',
      );

      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    });
  });

  describe('importFromWorkspace', () => {
    it('shows an informational message when no workspace config exists', async () => {
      const mgr = new WorkspaceConfigManager(
        makeConfigManager(),
        makeDataSourceManager(),
        makeLogger(),
      );

      (fs.existsSync as any).mockReturnValue(false);

      await mgr.importFromWorkspace();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'No .vscode/yoink.json found in this workspace.',
      );
    });

    it('reports parse failures without importing', async () => {
      const dsMgr = makeDataSourceManager();
      const mgr = new WorkspaceConfigManager(makeConfigManager(), dsMgr, makeLogger());

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue('{not json');

      await mgr.importFromWorkspace();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to parse .vscode/yoink.json. Check the file format.',
      );
      expect(dsMgr.add).not.toHaveBeenCalled();
    });

    it('shows a warning summary when import completes with warnings', async () => {
      const dsMgr = makeDataSourceManager();
      dsMgr.add.mockRejectedValue(new Error('API key missing'));
      const mgr = new WorkspaceConfigManager(makeConfigManager(), dsMgr, makeLogger());
      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [{
          repoUrl: 'https://github.com/acme/widgets',
          owner: 'acme',
          repo: 'widgets',
          branch: 'main',
          includePatterns: [],
          excludePatterns: [],
          syncSchedule: 'manual',
        }],
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(shareable));

      await mgr.importFromWorkspace();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 warning(s) — check the Yoink output log.'),
      );
    });
  });

  describe('detectAndPrompt', () => {
    it('prompts when workspace config exists', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [{ repoUrl: '', owner: 'a', repo: 'b', branch: 'main', includePatterns: [], excludePatterns: [], syncSchedule: 'manual' }],
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(shareable));
      (vscode.window.showInformationMessage as any).mockResolvedValue('Not Now');

      await mgr.detectAndPrompt();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Yoink config found in this workspace. Import data sources?',
        'Import',
        'Not Now',
      );
    });

    it('imports when the user accepts the workspace prompt', async () => {
      const dsMgr = makeDataSourceManager();
      const mgr = new WorkspaceConfigManager(makeConfigManager(), dsMgr, makeLogger());
      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [{
          repoUrl: 'https://github.com/acme/widgets',
          owner: 'acme',
          repo: 'widgets',
          branch: 'main',
          includePatterns: [],
          excludePatterns: [],
          syncSchedule: 'manual',
        }],
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(shareable));
      (vscode.window.showInformationMessage as any)
        .mockResolvedValueOnce('Import')
        .mockReturnValueOnce(undefined);

      await mgr.detectAndPrompt();

      expect(dsMgr.add).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
      }));
      expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(
        'Yoink: Imported 1 data source.',
      );
    });

    it('does nothing when no workspace config exists', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (fs.existsSync as any).mockReturnValue(false);

      await mgr.detectAndPrompt();

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('does nothing when config has no data sources', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({ version: 1, dataSources: [] }));

      await mgr.detectAndPrompt();

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });
});
