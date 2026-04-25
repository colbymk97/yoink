import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  openDatabase,
  getEmbeddingDimensions,
  recreateEmbeddingsTable,
} from '../../../src/storage/database';
import { ChunkStore } from '../../../src/storage/chunkStore';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('openDatabase', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoink-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('creates an in-memory database with all tables', () => {
    const db = openDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('meta');
    expect(tableNames).toContain('data_sources');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('sync_history');
    expect(tableNames).toContain('indexing_runs');
    expect(tableNames).toContain('indexing_run_files');
    db.close();
  });

  it('creates the vec0 virtual table', () => {
    const db = openDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(1);
    db.close();
  });

  it('records schema version in meta table', () => {
    const db = openDatabase();
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };

    expect(row.value).toBe('4');
    db.close();
  });

  it('records embedding dimensions in meta table', () => {
    const db = openDatabase({ dimensions: 768 });
    expect(getEmbeddingDimensions(db)).toBe(768);
    db.close();
  });

  it('defaults to 1536 dimensions', () => {
    const db = openDatabase();
    expect(getEmbeddingDimensions(db)).toBe(1536);
    db.close();
  });

  it('creates a file-backed database', () => {
    const dir = makeTempDir();
    const db = openDatabase({ storagePath: dir });
    const dbFile = path.join(dir, 'yoink.db');
    expect(fs.existsSync(dbFile)).toBe(true);
    db.close();
  });

  it('is idempotent — opening twice does not fail', () => {
    const dir = makeTempDir();
    const db1 = openDatabase({ storagePath: dir });
    db1.close();
    const db2 = openDatabase({ storagePath: dir });
    const row = db2
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(row.value).toBe('4');
    db2.close();
  });

  it('migrates v3 databases to v4 without losing chunks or FTS rows', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'yoink.db');
    const oldDb = new Database(dbPath);
    oldDb.pragma('foreign_keys = ON');
    sqliteVec.load(oldDb);
    oldDb.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '3');
      INSERT INTO meta (key, value) VALUES ('embedding_dimensions', '4');

      CREATE VIRTUAL TABLE embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding FLOAT[4]
      );

      CREATE TABLE data_sources (
        id                TEXT PRIMARY KEY,
        owner             TEXT NOT NULL,
        repo              TEXT NOT NULL,
        branch            TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'queued',
        last_synced_at    TEXT,
        last_sync_commit  TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE chunks (
        id              TEXT PRIMARY KEY,
        data_source_id  TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        content         TEXT NOT NULL,
        token_count     INTEGER NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE sync_history (
        id              TEXT PRIMARY KEY,
        data_source_id  TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        status          TEXT NOT NULL,
        files_processed INTEGER DEFAULT 0,
        chunks_created  INTEGER DEFAULT 0,
        error_message   TEXT,
        commit_sha      TEXT
      );

      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chunk_id       UNINDEXED,
        data_source_id UNINDEXED,
        file_path,
        content,
        tokenize = 'porter ascii'
      );

      INSERT INTO data_sources (id, owner, repo, branch, status)
      VALUES ('ds1', 'owner', 'repo', 'main', 'ready');
      INSERT INTO chunks (id, data_source_id, file_path, start_line, end_line, content, token_count)
      VALUES ('c1', 'ds1', 'src/search.ts', 1, 3, 'legacy migration sentinel', 3);
      INSERT INTO chunks_fts (chunk_id, data_source_id, file_path, content)
      VALUES ('c1', 'ds1', 'src/search.ts', 'legacy migration sentinel');
    `);
    oldDb.close();

    const db = openDatabase({ storagePath: dir, dimensions: 4 });
    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    const syncColumns = db.prepare('PRAGMA table_info(sync_history)').all() as Array<{ name: string }>;
    const indexingRuns = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='indexing_runs'")
      .all();

    expect(version.value).toBe('4');
    expect(syncColumns.map((c) => c.name)).toContain('tokens_indexed');
    expect(indexingRuns).toHaveLength(1);
    expect(new ChunkStore(db).searchFts('sentinel', ['ds1'], 10).map((r) => r.chunkId)).toEqual([
      'c1',
    ]);
    db.close();
  });
});

describe('recreateEmbeddingsTable', () => {
  it('drops and recreates with new dimensions', () => {
    const db = openDatabase({ dimensions: 1536 });

    // Insert a test embedding
    const ds = db.prepare(
      "INSERT INTO data_sources (id, owner, repo, branch, status) VALUES ('ds1', 'o', 'r', 'main', 'ready')",
    );
    ds.run();
    db.prepare(
      "INSERT INTO chunks (id, data_source_id, file_path, start_line, end_line, content, token_count) VALUES ('c1', 'ds1', 'a.ts', 1, 10, 'code', 50)",
    ).run();

    const vec = new Float32Array(1536).fill(0.1);
    db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      'c1',
      Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    );

    // Recreate with different dimensions
    recreateEmbeddingsTable(db, 768);
    expect(getEmbeddingDimensions(db)).toBe(768);

    // Old embedding is gone
    const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as { c: number };
    expect(count.c).toBe(0);

    // Can insert with new dimensions
    const vec768 = new Float32Array(768).fill(0.2);
    db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      'c1',
      Buffer.from(vec768.buffer, vec768.byteOffset, vec768.byteLength),
    );
    const count2 = db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as { c: number };
    expect(count2.c).toBe(1);

    db.close();
  });
});
