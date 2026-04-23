import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../../src/storage/database';
import { IndexingRunStore } from '../../../src/storage/indexingRunStore';

describe('IndexingRunStore', () => {
  let db: Database.Database;
  let store: IndexingRunStore;

  beforeEach(() => {
    db = openDatabase();
    store = new IndexingRunStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a new run and pending manifest entries', () => {
    const run = store.startOrResumeRun('ds1', 'key-1', 'abc123', [
      { path: 'a.ts', sha: 'sha-a', size: 10, type: 'blob' },
      { path: 'b.ts', sha: 'sha-b', size: 20, type: 'blob' },
    ]);

    expect(run.status).toBe('running');
    expect(run.totalFiles).toBe(2);
    expect(store.getPendingFiles(run.id)).toHaveLength(2);
  });

  it('resumes an incomplete run with the same run key', () => {
    const first = store.startOrResumeRun('ds1', 'key-1', 'abc123', [
      { path: 'a.ts', sha: 'sha-a', size: 10, type: 'blob' },
      { path: 'b.ts', sha: 'sha-b', size: 20, type: 'blob' },
    ]);
    store.markFileCompleted(first.id, 'a.ts', 2, 50);
    store.failRun(first.id, 'tarball');

    const resumed = store.startOrResumeRun('ds1', 'key-1', 'abc123', [
      { path: 'a.ts', sha: 'sha-a', size: 10, type: 'blob' },
      { path: 'b.ts', sha: 'sha-b', size: 20, type: 'blob' },
    ]);

    expect(resumed.id).toBe(first.id);
    expect(store.getPendingFiles(resumed.id).map((f) => f.path)).toEqual(['b.ts']);
    expect(store.getSummary(resumed.id)).toEqual({
      totalFiles: 2,
      completedFiles: 1,
      failedFiles: 0,
      chunkCount: 2,
      tokenCount: 50,
    });
  });

  it('tracks failed files for retry', () => {
    const run = store.startOrResumeRun('ds1', 'key-1', 'abc123', [
      { path: 'a.ts', sha: 'sha-a', size: 10, type: 'blob' },
    ]);

    store.markFileFailed(run.id, 'a.ts', 'Embedding batch failed');

    const pending = store.getPendingFiles(run.id);
    expect(pending).toHaveLength(1);
    const file = store.getAllFiles(run.id)[0];
    expect(file.status).toBe('failed');
    expect(file.errorMessage).toContain('Embedding batch failed');
  });
});
