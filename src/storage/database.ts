import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as path from 'path';
import * as fs from 'fs';

const SCHEMA_VERSION = 3;
const DEFAULT_DIMENSIONS = 1536;
const META_EMBEDDING_DIMENSIONS = 'embedding_dimensions';
const META_EMBEDDING_CONFIG_FINGERPRINT = 'embedding_config_fingerprint';
const META_SCHEMA_VERSION = 'schema_version';

export interface OpenDatabaseOptions {
  /** Directory to store the DB file. If omitted, uses an in-memory DB. */
  storagePath?: string;
  /** Embedding dimensions for the vec0 table. Defaults to 1536. */
  dimensions?: number;
}

export function openDatabase(options: OpenDatabaseOptions = {}): Database.Database {
  let db: Database.Database;

  if (options.storagePath) {
    if (!fs.existsSync(options.storagePath)) {
      fs.mkdirSync(options.storagePath, { recursive: true });
    }
    const dbPath = path.join(options.storagePath, 'yoink.db');
    db = new Database(dbPath);
  } else {
    db = new Database(':memory:');
  }

  // Enable WAL mode for better concurrent read performance (no-op for :memory:)
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  sqliteVec.load(db);

  migrate(db, options.dimensions ?? DEFAULT_DIMENSIONS);
  return db;
}

function migrate(db: Database.Database, dimensions: number): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )`,
    );

    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('${META_EMBEDDING_DIMENSIONS}', ?)`,
    ).run(dimensions.toString());
  }

  if (currentVersion < 2) {
    // Recreate chunks and sync_history without FK constraints on data_source_id.
    // data_sources table is kept for DataSourceStore but no longer referenced by FK.
    db.exec(`
      DROP TABLE IF EXISTS sync_history;
      DROP TABLE IF EXISTS chunks;

      CREATE TABLE IF NOT EXISTS data_sources (
        id                TEXT PRIMARY KEY,
        owner             TEXT NOT NULL,
        repo              TEXT NOT NULL,
        branch            TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'queued',
        last_synced_at    TEXT,
        last_sync_commit  TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id              TEXT PRIMARY KEY,
        data_source_id  TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        content         TEXT NOT NULL,
        token_count     INTEGER NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_data_source ON chunks(data_source_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(data_source_id, file_path);

      CREATE TABLE IF NOT EXISTS sync_history (
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

      CREATE INDEX IF NOT EXISTS idx_sync_history_ds ON sync_history(data_source_id);
    `);

    setSchemaVersion(db, 2);
  }

  if (currentVersion < 3) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id       UNINDEXED,
        data_source_id UNINDEXED,
        file_path,
        content,
        tokenize = 'porter ascii'
      );
      INSERT INTO chunks_fts (chunk_id, data_source_id, file_path, content)
      SELECT id, data_source_id, file_path, content FROM chunks;
    `);
    setSchemaVersion(db, SCHEMA_VERSION);
  }
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = getMetaValue(db, META_SCHEMA_VERSION);
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('${META_SCHEMA_VERSION}', ?)`,
  ).run(version.toString());
}

export function getEmbeddingDimensions(db: Database.Database): number {
  const row = getMetaValue(db, META_EMBEDDING_DIMENSIONS);
  return row ? parseInt(row.value, 10) : DEFAULT_DIMENSIONS;
}

export function getEmbeddingConfigFingerprint(db: Database.Database): string | undefined {
  return getMetaValue(db, META_EMBEDDING_CONFIG_FINGERPRINT)?.value;
}

export function setEmbeddingConfigFingerprint(
  db: Database.Database,
  fingerprint: string,
): void {
  setMetaValue(db, META_EMBEDDING_CONFIG_FINGERPRINT, fingerprint);
}

/**
 * Drop and recreate the embeddings vec0 table with new dimensions.
 * All existing embeddings are lost — callers must re-index.
 */
export function recreateEmbeddingsTable(db: Database.Database, dimensions: number): void {
  db.exec('DROP TABLE IF EXISTS embeddings');
  db.exec(
    `CREATE VIRTUAL TABLE embeddings USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    )`,
  );
  setMetaValue(db, META_EMBEDDING_DIMENSIONS, dimensions.toString());
}

export function resetEmbeddingsTable(db: Database.Database, dimensions: number): void {
  if (getEmbeddingDimensions(db) === dimensions) {
    db.exec('DELETE FROM embeddings');
    return;
  }

  recreateEmbeddingsTable(db, dimensions);
}

function getMetaValue(db: Database.Database, key: string): { value: string } | undefined {
  return db.prepare(
    'SELECT value FROM meta WHERE key = ?',
  ).get(key) as { value: string } | undefined;
}

function setMetaValue(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  ).run(key, value);
}
