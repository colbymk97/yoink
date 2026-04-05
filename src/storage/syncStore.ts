import Database from 'better-sqlite3';

export interface SyncRecord {
  id: string;
  dataSourceId: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  filesProcessed: number;
  chunksCreated: number;
  errorMessage: string | null;
  commitSha: string | null;
}

export class SyncStore {
  private readonly insertStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly getLatestStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO sync_history (id, data_source_id, started_at, status, commit_sha)
      VALUES (?, ?, ?, 'running', ?)
    `);
    this.updateStmt = db.prepare(`
      UPDATE sync_history
      SET completed_at = ?, status = ?, files_processed = ?, chunks_created = ?, error_message = ?
      WHERE id = ?
    `);
    this.getLatestStmt = db.prepare(`
      SELECT * FROM sync_history
      WHERE data_source_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
  }

  startSync(id: string, dataSourceId: string, commitSha: string | null): void {
    this.insertStmt.run(id, dataSourceId, new Date().toISOString(), commitSha);
  }

  completeSync(
    id: string,
    filesProcessed: number,
    chunksCreated: number,
  ): void {
    this.updateStmt.run(
      new Date().toISOString(),
      'completed',
      filesProcessed,
      chunksCreated,
      null,
      id,
    );
  }

  failSync(id: string, errorMessage: string): void {
    this.updateStmt.run(
      new Date().toISOString(),
      'failed',
      0,
      0,
      errorMessage,
      id,
    );
  }

  getLatest(dataSourceId: string): SyncRecord | undefined {
    const row = this.getLatestStmt.get(dataSourceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      dataSourceId: row.data_source_id as string,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | null,
      status: row.status as SyncRecord['status'],
      filesProcessed: row.files_processed as number,
      chunksCreated: row.chunks_created as number,
      errorMessage: row.error_message as string | null,
      commitSha: row.commit_sha as string | null,
    };
  }
}
