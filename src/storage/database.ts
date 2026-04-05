import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const SCHEMA_VERSION = 1;

export function openDatabase(globalStoragePath: string, vecExtensionPath: string): Database.Database {
  if (!fs.existsSync(globalStoragePath)) {
    fs.mkdirSync(globalStoragePath, { recursive: true });
  }

  const dbPath = path.join(globalStoragePath, 'repolens.db');
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  db.loadExtension(vecExtensionPath);

  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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
        data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        file_path       TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        content         TEXT NOT NULL,
        token_count     INTEGER NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_data_source ON chunks(data_source_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(data_source_id, file_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding FLOAT[1536]
      );

      CREATE TABLE IF NOT EXISTS sync_history (
        id              TEXT PRIMARY KEY,
        data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
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

    setSchemaVersion(db, SCHEMA_VERSION);
  }
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(version.toString());
}
