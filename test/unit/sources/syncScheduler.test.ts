import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultVal: any) => defaultVal,
    }),
  },
}));

import { SyncScheduler } from '../../../src/sources/sync/syncScheduler';

function makeDs(id: string, schedule: string, lastSyncedAt: string | null = null, status = 'ready') {
  return {
    id,
    syncSchedule: schedule,
    lastSyncedAt,
    owner: 'o',
    repo: 'r',
    branch: 'main',
    status,
  };
}

describe('SyncScheduler', () => {
  let onSync: ReturnType<typeof vi.fn>;
  let configManager: any;

  beforeEach(() => {
    vi.useFakeTimers();
    onSync = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers onStartup data sources on start', () => {
    configManager = {
      getDataSources: () => [
        makeDs('ds-1', 'onStartup'),
        makeDs('ds-2', 'manual'),
        makeDs('ds-3', 'onStartup'),
      ],
    };

    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();

    expect(onSync).toHaveBeenCalledWith('ds-1');
    expect(onSync).toHaveBeenCalledWith('ds-3');
    expect(onSync).not.toHaveBeenCalledWith('ds-2');

    scheduler.dispose();
  });

  it('does not trigger manual sources on startup', () => {
    configManager = {
      getDataSources: () => [makeDs('ds-1', 'manual')],
    };

    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();

    expect(onSync).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it('skips deleting onStartup sources', () => {
    configManager = {
      getDataSources: () => [
        makeDs('ds-1', 'onStartup', null, 'deleting'),
        makeDs('ds-2', 'onStartup'),
      ],
    };

    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();

    expect(onSync).not.toHaveBeenCalledWith('ds-1');
    expect(onSync).toHaveBeenCalledWith('ds-2');
    scheduler.dispose();
  });

  it('triggers daily sources that have never synced', () => {
    configManager = {
      getDataSources: () => [makeDs('ds-1', 'daily', null)],
    };

    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();
    onSync.mockClear();

    // Advance 1 hour to trigger the daily check
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(onSync).toHaveBeenCalledWith('ds-1');
    scheduler.dispose();
  });

  it('skips deleting daily sources', () => {
    configManager = {
      getDataSources: () => [makeDs('ds-1', 'daily', null, 'deleting')],
    };

    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();
    onSync.mockClear();

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(onSync).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it('triggers daily sources older than 24 hours', () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    configManager = {
      getDataSources: () => [makeDs('ds-1', 'daily', oldDate)],
    };

    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();
    onSync.mockClear();

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(onSync).toHaveBeenCalledWith('ds-1');
    scheduler.dispose();
  });

  it('skips daily sources synced less than 24 hours ago', () => {
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    configManager = {
      getDataSources: () => [makeDs('ds-1', 'daily', recentDate)],
    };

    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();
    onSync.mockClear();

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(onSync).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it('cleans up interval on dispose', () => {
    configManager = { getDataSources: () => [] };
    const scheduler = new SyncScheduler(configManager, onSync);
    scheduler.start();
    scheduler.dispose();

    // Advancing timers should not trigger anything
    onSync.mockClear();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(onSync).not.toHaveBeenCalled();
  });
});
