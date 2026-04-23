import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, getEmbeddingDimensions, recreateEmbeddingsTable } from '../../../src/storage/database';
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
