import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode
const changeListeners: Array<(e: any) => void> = [];
const fileWatcherCallbacks: { change: Array<() => void>; create: Array<() => void> } = {
  change: [],
  create: [],
};

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
  EventEmitter: class {
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      changeListeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire(data: any) {
      this.listeners.forEach((l) => l(data));
    }
    dispose() {}
  },
  RelativePattern: class {
    constructor(public base: string, public pattern: string) {}
  },
  workspace: {
    createFileSystemWatcher: vi.fn().mockImplementation(() => ({
      onDidChange: (cb: () => void) => {
        fileWatcherCallbacks.change.push(cb);
        return { dispose: vi.fn() };
      },
      onDidCreate: (cb: () => void) => {
        fileWatcherCallbacks.create.push(cb);
        return { dispose: vi.fn() };
      },
      dispose: vi.fn(),
    })),
  },
}));

import { ConfigManager } from '../../../src/config/configManager';
import { createDefaultConfig, DataSourceConfig } from '../../../src/config/configSchema';

describe('ConfigManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repolens-test-'));
    changeListeners.length = 0;
    fileWatcherCallbacks.change.length = 0;
    fileWatcherCallbacks.create.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeUri() {
    return { fsPath: tmpDir } as any;
  }

  function writeConfig(config: any) {
    fs.writeFileSync(path.join(tmpDir, 'repolens.json'), JSON.stringify(config, null, 2));
  }

  function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'repolens.json'), 'utf-8'));
  }

  it('returns default config when no file exists', () => {
    const manager = new ConfigManager(makeUri());
    const config = manager.getConfig();
    expect(config.version).toBe(1);
    expect(config.dataSources).toEqual([]);
    expect(config.tools).toEqual([]);
    manager.dispose();
  });

  it('loads existing config from disk', () => {
    const existing = createDefaultConfig();
    existing.dataSources.push({
      id: 'ds-1',
      repoUrl: 'https://github.com/test/repo',
      owner: 'test',
      repo: 'repo',
      branch: 'main',
      includePatterns: [],
      excludePatterns: [],
      syncSchedule: 'manual',
      lastSyncedAt: null,
      lastSyncCommitSha: null,
      status: 'ready',
    });
    writeConfig(existing);

    const manager = new ConfigManager(makeUri());
    expect(manager.getDataSources()).toHaveLength(1);
    expect(manager.getDataSource('ds-1')?.owner).toBe('test');
    manager.dispose();
  });

  it('handles corrupt JSON by backing up and resetting to defaults', () => {
    const configPath = path.join(tmpDir, 'repolens.json');
    fs.writeFileSync(configPath, '{corrupt json!!!');

    const manager = new ConfigManager(makeUri());
    const config = manager.getConfig();

    // Should have reset to defaults
    expect(config.version).toBe(1);
    expect(config.dataSources).toEqual([]);

    // Backup should exist
    expect(fs.existsSync(configPath + '.bak')).toBe(true);
    expect(fs.readFileSync(configPath + '.bak', 'utf-8')).toBe('{corrupt json!!!');
    manager.dispose();
  });

  it('add/update/remove data source round-trip', () => {
    const manager = new ConfigManager(makeUri());

    const ds: DataSourceConfig = {
      id: 'ds-1',
      repoUrl: 'https://github.com/test/repo',
      owner: 'test',
      repo: 'repo',
      branch: 'main',
      includePatterns: [],
      excludePatterns: [],
      syncSchedule: 'manual',
      lastSyncedAt: null,
      lastSyncCommitSha: null,
      status: 'queued',
    };

    manager.addDataSource(ds);
    manager.flush();
    expect(manager.getDataSource('ds-1')).toBeDefined();

    manager.updateDataSource('ds-1', { status: 'ready' });
    manager.flush();
    expect(manager.getDataSource('ds-1')?.status).toBe('ready');

    manager.removeDataSource('ds-1');
    manager.flush();
    expect(manager.getDataSource('ds-1')).toBeUndefined();
    manager.dispose();
  });

  it('add/update/remove tool round-trip', () => {
    const manager = new ConfigManager(makeUri());

    manager.addTool({ id: 't-1', name: 'my-tool', description: 'test', dataSourceIds: ['ds-1'] });
    manager.flush();
    expect(manager.getTool('t-1')).toBeDefined();

    manager.updateTool('t-1', { description: 'updated' });
    manager.flush();
    expect(manager.getTool('t-1')?.description).toBe('updated');

    manager.removeTool('t-1');
    manager.flush();
    expect(manager.getTool('t-1')).toBeUndefined();
    manager.dispose();
  });

  it('removeDataSource cleans tool references', () => {
    const manager = new ConfigManager(makeUri());

    manager.addDataSource({
      id: 'ds-1', repoUrl: '', owner: 'o', repo: 'r', branch: 'main',
      includePatterns: [], excludePatterns: [], syncSchedule: 'manual',
      lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
    });
    manager.addTool({ id: 't-1', name: 'tool', description: '', dataSourceIds: ['ds-1', 'ds-2'] });
    manager.flush();

    manager.removeDataSource('ds-1');
    manager.flush();

    expect(manager.getTool('t-1')?.dataSourceIds).toEqual(['ds-2']);
    manager.dispose();
  });

  it('fires onDidChange when config is saved', () => {
    const manager = new ConfigManager(makeUri());
    const listener = vi.fn();
    manager.onDidChange(listener);

    manager.addDataSource({
      id: 'ds-1', repoUrl: '', owner: 'o', repo: 'r', branch: 'main',
      includePatterns: [], excludePatterns: [], syncSchedule: 'manual',
      lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
    });
    manager.flush();

    expect(listener).toHaveBeenCalled();
    manager.dispose();
  });

  it('debounces rapid writes', async () => {
    const manager = new ConfigManager(makeUri());

    // Rapid updates
    for (let i = 0; i < 10; i++) {
      manager.addDataSource({
        id: `ds-${i}`, repoUrl: '', owner: 'o', repo: `r${i}`, branch: 'main',
        includePatterns: [], excludePatterns: [], syncSchedule: 'manual',
        lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
      });
    }

    // File should not exist yet (debounced)
    const configPath = path.join(tmpDir, 'repolens.json');
    const existsBeforeFlush = fs.existsSync(configPath);

    // Flush to write
    manager.flush();

    // Now file should exist with all 10 data sources
    const saved = readConfig();
    expect(saved.dataSources).toHaveLength(10);

    manager.dispose();
  });

  it('persists config across save → reload', () => {
    const manager1 = new ConfigManager(makeUri());
    manager1.addDataSource({
      id: 'ds-1', repoUrl: '', owner: 'acme', repo: 'widgets', branch: 'main',
      includePatterns: ['**/*.ts'], excludePatterns: [], syncSchedule: 'daily',
      lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
    });
    manager1.flush();
    manager1.dispose();

    // Reload from disk
    const manager2 = new ConfigManager(makeUri());
    expect(manager2.getDataSource('ds-1')?.owner).toBe('acme');
    expect(manager2.getDataSource('ds-1')?.includePatterns).toEqual(['**/*.ts']);
    manager2.dispose();
  });

  it('reloads when external file change is detected', () => {
    const manager = new ConfigManager(makeUri());
    manager.flush(); // ensure initial write if needed

    // Simulate external edit by writing directly and firing watcher
    const updated = createDefaultConfig();
    updated.dataSources.push({
      id: 'ext-1', repoUrl: '', owner: 'ext', repo: 'repo', branch: 'main',
      includePatterns: [], excludePatterns: [], syncSchedule: 'manual',
      lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
    });
    writeConfig(updated);

    // Fire file watcher callback
    fileWatcherCallbacks.change.forEach((cb) => cb());

    expect(manager.getDataSource('ext-1')?.owner).toBe('ext');
    manager.dispose();
  });

  it('getDefaultExcludePatterns returns configured patterns', () => {
    const manager = new ConfigManager(makeUri());
    const patterns = manager.getDefaultExcludePatterns();
    expect(patterns).toContain('**/node_modules/**');
    expect(patterns).toContain('**/dist/**');
    manager.dispose();
  });
});
