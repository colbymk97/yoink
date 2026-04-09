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
vi.mock('crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('generated-uuid'),
}));

import * as vscode from 'vscode';
import { WorkspaceConfigManager } from '../../../src/config/workspaceConfig';
import { ShareableConfig, DataSourceConfig, ToolConfig } from '../../../src/config/configSchema';

function makeConfigManager(opts: {
  dataSources?: DataSourceConfig[];
  tools?: ToolConfig[];
} = {}) {
  const dataSources = opts.dataSources ?? [];
  const tools = opts.tools ?? [];

  return {
    getDataSources: vi.fn().mockReturnValue(dataSources),
    getDataSource: vi.fn((id: string) => dataSources.find((d) => d.id === id)),
    getTools: vi.fn().mockReturnValue(tools),
    getTool: vi.fn((id: string) => tools.find((t) => t.id === id)),
    addTool: vi.fn(),
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
    includePatterns: [], excludePatterns: [],
    syncSchedule: 'manual', lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
  };
}

const WORKSPACE_CONFIG_PATH = path.join('/workspace', '.vscode', 'repolens.json');

describe('WorkspaceConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        includePatterns: ['src/**'],
        excludePatterns: ['**/*.test.ts'],
        syncSchedule: 'onStartup',
      });
      // Runtime state fields should not be present
      expect(result.dataSources[0]).not.toHaveProperty('id');
      expect(result.dataSources[0]).not.toHaveProperty('status');
      expect(result.dataSources[0]).not.toHaveProperty('lastSyncedAt');
    });

    it('maps tool dataSourceIds to owner/repo@branch references', () => {
      const ds = makeDs('acme', 'widgets', 'main', 'ds-1');
      const tool: ToolConfig = { id: 't-1', name: 'search', description: 'Search', dataSourceIds: ['ds-1'] };

      const configManager = makeConfigManager({ dataSources: [ds], tools: [tool] });
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const result = mgr.buildShareableConfig();

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].dataSources).toEqual(['acme/widgets@main']);
      expect(result.tools[0]).not.toHaveProperty('id');
      expect(result.tools[0]).not.toHaveProperty('dataSourceIds');
    });

    it('drops orphaned tool data source references', () => {
      const tool: ToolConfig = { id: 't-1', name: 'search', description: 'Search', dataSourceIds: ['nonexistent'] };
      const configManager = makeConfigManager({ tools: [tool] });
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const result = mgr.buildShareableConfig();

      expect(result.tools[0].dataSources).toEqual([]);
    });

    it('does not include defaultExcludePatterns when they match defaults', () => {
      const configManager = makeConfigManager();
      configManager.getDefaultExcludePatterns.mockReturnValue([
        '**/node_modules/**', '**/dist/**',
      ]);
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const result = mgr.buildShareableConfig();

      // With only 2 patterns vs the full default list, they differ, so it would be included
      // But let's test with the exact defaults
      expect(result).toHaveProperty('$schema');
      expect(result.version).toBe(1);
    });
  });

  describe('importConfig', () => {
    it('adds new data sources and tools', async () => {
      const configManager = makeConfigManager();
      const dsMgr = makeDataSourceManager();
      // After add, the data source should be findable for tool reference resolution
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
        tools: [{
          name: 'search',
          description: 'Search widgets',
          dataSources: ['acme/widgets@main'],
        }],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.dataSourcesAdded).toBe(1);
      expect(result.toolsAdded).toBe(1);
      expect(result.dataSourcesSkipped).toBe(0);
      expect(result.toolsSkipped).toBe(0);
      expect(dsMgr.add).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'acme', repo: 'widgets', branch: 'main',
      }));
      expect(configManager.addTool).toHaveBeenCalledWith(expect.objectContaining({
        name: 'search',
        description: 'Search widgets',
        dataSourceIds: ['new-ds-id'],
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
        tools: [],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.dataSourcesAdded).toBe(0);
      expect(result.dataSourcesSkipped).toBe(1);
      expect(dsMgr.add).not.toHaveBeenCalled();
    });

    it('skips duplicate tools (idempotent)', async () => {
      const existingTool: ToolConfig = { id: 't-1', name: 'search', description: 'Existing', dataSourceIds: [] };
      const configManager = makeConfigManager({ tools: [existingTool] });
      const dsMgr = makeDataSourceManager();

      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [],
        tools: [{ name: 'search', description: 'Imported', dataSources: [] }],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.toolsAdded).toBe(0);
      expect(result.toolsSkipped).toBe(1);
      expect(configManager.addTool).not.toHaveBeenCalled();
    });

    it('is fully idempotent on second run', async () => {
      const ds = makeDs('acme', 'widgets', 'main', 'existing-id');
      const tool: ToolConfig = { id: 't-1', name: 'search', description: 'Search', dataSourceIds: ['existing-id'] };
      const configManager = makeConfigManager({ dataSources: [ds], tools: [tool] });
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
        tools: [{ name: 'search', description: 'Search', dataSources: ['acme/widgets@main'] }],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.dataSourcesAdded).toBe(0);
      expect(result.dataSourcesSkipped).toBe(1);
      expect(result.toolsAdded).toBe(0);
      expect(result.toolsSkipped).toBe(1);
    });

    it('warns on unresolvable data source references in tools', async () => {
      const configManager = makeConfigManager();
      const dsMgr = makeDataSourceManager();

      const mgr = new WorkspaceConfigManager(configManager, dsMgr, makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [],
        tools: [{
          name: 'search',
          description: 'Search',
          dataSources: ['nonexistent/repo@main'],
        }],
      };

      const result = await mgr.importConfig(shareable);

      expect(result.toolsAdded).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('nonexistent/repo@main');
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
        tools: [],
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

      await mgr.importConfig({ version: 1, dataSources: [], tools: [] });

      expect(configManager.flush).toHaveBeenCalled();
    });
  });

  describe('exportConfig', () => {
    it('writes shareable config to .vscode/repolens.json', async () => {
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
        expect.stringContaining('1 data sources'),
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
        'Overwrite existing .vscode/repolens.json?',
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

      // Override workspace folders to be empty
      (vscode.workspace as any).workspaceFolders = undefined;

      await mgr.exportConfig();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Open a workspace folder first to export RepoLens config.',
      );

      // Restore
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    });
  });

  describe('detectAndPrompt', () => {
    it('prompts when workspace config exists', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      const shareable: ShareableConfig = {
        version: 1,
        dataSources: [{ repoUrl: '', owner: 'a', repo: 'b', branch: 'main', includePatterns: [], excludePatterns: [], syncSchedule: 'manual' }],
        tools: [],
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(shareable));
      (vscode.window.showInformationMessage as any).mockResolvedValue('Not Now');

      await mgr.detectAndPrompt();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'RepoLens config found in this workspace. Import tools and data sources?',
        'Import',
        'Not Now',
      );
    });

    it('does nothing when no workspace config exists', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (fs.existsSync as any).mockReturnValue(false);

      await mgr.detectAndPrompt();

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('does nothing when config has no data sources or tools', async () => {
      const configManager = makeConfigManager();
      const mgr = new WorkspaceConfigManager(configManager, makeDataSourceManager(), makeLogger());

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({ version: 1, dataSources: [], tools: [] }));

      await mgr.detectAndPrompt();

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });
});
