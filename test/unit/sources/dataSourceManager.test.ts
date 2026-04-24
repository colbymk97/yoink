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
      getDataSource: (id: string) => dataSources.find((ds) => ds.id === id),
      addDataSource: vi.fn().mockImplementation((ds: DataSourceConfig) => {
        dataSources.push(ds);
      }),
      updateDataSource: vi.fn().mockImplementation((id: string, updates: Partial<DataSourceConfig>) => {
        const ds = dataSources.find((d) => d.id === id);
        if (ds) Object.assign(ds, updates);
      }),
      removeDataSource: vi.fn().mockImplementation((id: string) => {
        dataSources = dataSources.filter((d) => d.id !== id);
      }),
      flush: vi.fn(),
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

  it('sync skips deleting data sources', async () => {
    const ds = await manager.add(makeOptions());
    ds.status = 'deleting';

    await manager.sync(ds.id);

    expect(embeddingManager.ensureConfigured).toHaveBeenCalledTimes(1);
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect(configManager.updateDataSource).not.toHaveBeenCalledWith(ds.id, { status: 'queued' });
  });

  it('syncAll syncs all data sources', async () => {
    const ds1 = await manager.add(makeOptions({ owner: 'a', repo: 'r1' }));
    const ds2 = await manager.add(makeOptions({ owner: 'b', repo: 'r2' }));

    await manager.syncAll();

    expect(pipeline.enqueue).toHaveBeenCalledWith(ds1.id);
    expect(pipeline.enqueue).toHaveBeenCalledWith(ds2.id);
  });

  it('syncAll skips deleting data sources', async () => {
    const ds1 = await manager.add(makeOptions({ owner: 'a', repo: 'r1' }));
    const ds2 = await manager.add(makeOptions({ owner: 'b', repo: 'r2' }));
    ds2.status = 'deleting';
    pipeline.enqueue.mockClear();

    await manager.syncAll();

    expect(pipeline.enqueue).toHaveBeenCalledWith(ds1.id);
    expect(pipeline.enqueue).not.toHaveBeenCalledWith(ds2.id);
  });

  it('remove cleans up pipeline and config', async () => {
    const ds = await manager.add(makeOptions());

    await manager.remove(ds.id);

    expect(pipeline.removeDataSource).toHaveBeenCalledWith(ds.id);
    expect(configManager.removeDataSource).toHaveBeenCalledWith(ds.id);
  });

  it('remove marks the data source as deleting before cleanup', async () => {
    const ds = await manager.add(makeOptions());

    const promise = manager.remove(ds.id);

    expect(ds.status).toBe('deleting');
    expect(configManager.updateDataSource).toHaveBeenCalledWith(ds.id, {
      status: 'deleting',
      errorMessage: undefined,
    });
    expect(configManager.flush).toHaveBeenCalled();

    await promise;
  });

  it('remove leaves the source in error when cleanup fails', async () => {
    const ds = await manager.add(makeOptions());
    pipeline.removeDataSource.mockRejectedValue(new Error('database locked'));

    await expect(manager.remove(ds.id)).rejects.toThrow('database locked');

    expect(configManager.removeDataSource).not.toHaveBeenCalledWith(ds.id);
    expect(ds.status).toBe('error');
    expect(ds.errorMessage).toBe('Delete failed: database locked');
  });

  it('remove does nothing when the data source is already deleting', async () => {
    const ds = await manager.add(makeOptions());
    ds.status = 'deleting';

    await manager.remove(ds.id);

    expect(pipeline.removeDataSource).not.toHaveBeenCalled();
    expect(configManager.removeDataSource).not.toHaveBeenCalled();
  });

  it('recovers interrupted deletions on startup', async () => {
    const ds = await manager.add(makeOptions());
    ds.status = 'deleting';

    manager.recoverInterruptedDeletions();

    expect(ds.status).toBe('error');
    expect(ds.errorMessage).toBe('Deletion was interrupted. Remove again to retry.');
    expect(configManager.flush).toHaveBeenCalled();
  });
});
