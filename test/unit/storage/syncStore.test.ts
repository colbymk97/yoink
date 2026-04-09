import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../../src/storage/database';
import { SyncStore } from '../../../src/storage/syncStore';
import { DataSourceStore } from '../../../src/storage/dataSourceStore';

describe('SyncStore', () => {
  let db: Database.Database;
  let syncStore: SyncStore;
  let dsStore: DataSourceStore;

  beforeEach(() => {
    db = openDatabase();
    syncStore = new SyncStore(db);
    dsStore = new DataSourceStore(db);
    dsStore.insert('ds1', 'owner', 'repo', 'main');
  });

  afterEach(() => {
    db.close();
  });

  it('starts a sync record', () => {
    syncStore.startSync('sync-1', 'ds1', 'abc123');

    const record = syncStore.getLatest('ds1');
    expect(record).toBeDefined();
    expect(record!.id).toBe('sync-1');
    expect(record!.dataSourceId).toBe('ds1');
    expect(record!.status).toBe('running');
    expect(record!.commitSha).toBe('abc123');
    expect(record!.completedAt).toBeNull();
  });

  it('completes a sync record', () => {
    syncStore.startSync('sync-1', 'ds1', 'abc123');
    syncStore.completeSync('sync-1', 42, 150);

    const record = syncStore.getLatest('ds1');
    expect(record!.status).toBe('completed');
    expect(record!.filesProcessed).toBe(42);
    expect(record!.chunksCreated).toBe(150);
    expect(record!.completedAt).not.toBeNull();
    expect(record!.errorMessage).toBeNull();
  });

  it('fails a sync record', () => {
    syncStore.startSync('sync-1', 'ds1', 'abc123');
    syncStore.failSync('sync-1', 'Rate limit exceeded');

    const record = syncStore.getLatest('ds1');
    expect(record!.status).toBe('failed');
    expect(record!.errorMessage).toBe('Rate limit exceeded');
    expect(record!.completedAt).not.toBeNull();
  });

  it('returns undefined for non-existent data source', () => {
    expect(syncStore.getLatest('nonexistent')).toBeUndefined();
  });

  it('getLatest returns the most recent sync', () => {
    syncStore.startSync('sync-1', 'ds1', 'aaa');
    syncStore.completeSync('sync-1', 10, 50);

    // Small delay to ensure different timestamps
    syncStore.startSync('sync-2', 'ds1', 'bbb');

    const latest = syncStore.getLatest('ds1');
    expect(latest!.id).toBe('sync-2');
    expect(latest!.commitSha).toBe('bbb');
  });

  it('getByDataSource returns all sync records', () => {
    syncStore.startSync('sync-1', 'ds1', 'aaa');
    syncStore.completeSync('sync-1', 10, 50);
    syncStore.startSync('sync-2', 'ds1', 'bbb');
    syncStore.completeSync('sync-2', 12, 55);

    const records = syncStore.getByDataSource('ds1');
    expect(records).toHaveLength(2);
    // Most recent first
    expect(records[0].id).toBe('sync-2');
    expect(records[1].id).toBe('sync-1');
  });

  it('handles null commit sha', () => {
    syncStore.startSync('sync-1', 'ds1', null);

    const record = syncStore.getLatest('ds1');
    expect(record!.commitSha).toBeNull();
  });

  it('records persist independently of data_sources table', () => {
    syncStore.startSync('sync-1', 'ds1', 'abc');
    syncStore.completeSync('sync-1', 5, 20);

    const record = syncStore.getLatest('ds1');
    expect(record).toBeDefined();
    expect(record!.status).toBe('completed');
  });
});
