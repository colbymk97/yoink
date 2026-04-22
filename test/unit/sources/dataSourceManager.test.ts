import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {
    showErrorMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

import { DataSourceManager, AddDataSourceOptions } from '../../../src/sources/dataSourceManager';
import { DataSourceConfig } from '../../../src/config/configSchema';

function makeOptions(overrides: Partial<AddDataSourceOptions> = {}): AddDataSourceOptions {
  return {
    repoUrl: 'https://github.com/acme/widgets',
    owner: 'acme',
    repo: 'widgets',
    branch: 'main',
    includePatterns: [],
    excludePatterns: [],
    syncSchedule: 'manual',
    ...overrides,
  };
}

describe('DataSourceManager', () => {
  let dataSources: DataSourceConfig[];
  let configManager: any;
  let pipeline: any;
  let embeddingManager: any;
  let manager: DataSourceManager;

  beforeEach(() => {
    dataSources = [];
    configManager = {
      getDataSources: () => dataSources,
      addDataSource: vi.fn().mockImplementation((ds: DataSourceConfig) => {
        dataSources.push(ds);
      }),
      updateDataSource: vi.fn(),
      removeDataSource: vi.fn().mockImplementation((id: string) => {
        dataSources = dataSources.filter((d) => d.id !== id);
      }),
    };
    pipeline = {
      enqueue: vi.fn(),
      removeDataSource: vi.fn(),
    };
    embeddingManager = {
      ensureConfigured: vi.fn().mockResolvedValue(true),
    };
    manager = new DataSourceManager(configManager, pipeline, embeddingManager);
  });

  it('add creates a data source and enqueues it', async () => {
    const ds = await manager.add(makeOptions());

    expect(ds.owner).toBe('acme');
    expect(ds.repo).toBe('widgets');
    expect(ds.status).toBe('queued');
    expect(ds.id).toBeTruthy();
    expect(configManager.addDataSource).toHaveBeenCalledWith(ds);
    expect(pipeline.enqueue).toHaveBeenCalledWith(ds.id);
  });

  it('add rejects duplicates (same owner/repo/branch)', async () => {
    await manager.add(makeOptions());

    await expect(
      manager.add(makeOptions()),
    ).rejects.toThrow('already configured');
  });

  it('isDuplicate is case-insensitive for owner and repo', async () => {
    await manager.add(makeOptions({ owner: 'Acme', repo: 'Widgets' }));

    expect(manager.isDuplicate('acme', 'widgets', 'main')).toBe(true);
    expect(manager.isDuplicate('ACME', 'WIDGETS', 'main')).toBe(true);
  });

  it('isDuplicate distinguishes different branches', async () => {
    await manager.add(makeOptions({ branch: 'main' }));

    expect(manager.isDuplicate('acme', 'widgets', 'main')).toBe(true);
    expect(manager.isDuplicate('acme', 'widgets', 'develop')).toBe(false);
  });

  it('sync enqueues the data source', async () => {
    const ds = await manager.add(makeOptions());

    await manager.sync(ds.id);

    expect(configManager.updateDataSource).toHaveBeenCalledWith(ds.id, { status: 'queued' });
    expect(pipeline.enqueue).toHaveBeenCalledWith(ds.id);
  });

  it('syncAll syncs all data sources', async () => {
    const ds1 = await manager.add(makeOptions({ owner: 'a', repo: 'r1' }));
    const ds2 = await manager.add(makeOptions({ owner: 'b', repo: 'r2' }));

    await manager.syncAll();

    expect(pipeline.enqueue).toHaveBeenCalledWith(ds1.id);
    expect(pipeline.enqueue).toHaveBeenCalledWith(ds2.id);
  });

  it('remove cleans up pipeline and config', async () => {
    const ds = await manager.add(makeOptions());

    await manager.remove(ds.id);

    expect(pipeline.removeDataSource).toHaveBeenCalledWith(ds.id);
    expect(configManager.removeDataSource).toHaveBeenCalledWith(ds.id);
  });
});
