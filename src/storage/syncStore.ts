import Database from 'better-sqlite3';

export interface SyncRecord {
  id: string;
  dataSourceId: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  filesProcessed: number;
  filesTotal: number;
  chunksCreated: number;
  tokensIndexed: number;
  errorMessage: string | null;
  commitSha: string | null;
  fetchStrategy: string | null;
  lastFilePath: string | null;
}

export interface SyncResultDetails {
  filesProcessed: number;
  filesTotal: number;
  chunksCreated: number;
  tokensIndexed: number;
  fetchStrategy?: string;
  lastFilePath?: string | null;
}

export class SyncStore {
  private readonly insertStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly getLatestStmt: Database.Statement;
  private readonly getByDataSourceStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO sync_history (id, data_source_id, started_at, status, commit_sha)
      VALUES (?, ?, ?, 'running', ?)
    `);
    this.updateStmt = db.prepare(`
      UPDATE sync_history
      SET completed_at = ?,
          status = ?,
          files_processed = ?,
          files_total = ?,
          chunks_created = ?,
          tokens_indexed = ?,
          fetch_strategy = ?,
          last_file_path = ?,
          error_message = ?
      WHERE id = ?
    `);
    this.getLatestStmt = db.prepare(`
      SELECT * FROM sync_history
      WHERE data_source_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `);
    this.getByDataSourceStmt = db.prepare(`
      SELECT * FROM sync_history
      WHERE data_source_id = ?
      ORDER BY rowid DESC
    `);
  }

  startSync(id: string, dataSourceId: string, commitSha: string | null): void {
    this.insertStmt.run(id, dataSourceId, new Date().toISOString(), commitSha);
  }

  completeSync(
    id: string,
    details: SyncResultDetails,
  ): void {
    this.updateStmt.run(
      new Date().toISOString(),
      'completed',
      details.filesProcessed,
      details.filesTotal,
      details.chunksCreated,
      details.tokensIndexed,
      details.fetchStrategy ?? null,
      details.lastFilePath ?? null,
      null,
      id,
    );
  }

  failSync(id: string, errorMessage: string, details?: Partial<SyncResultDetails>): void {
    this.updateStmt.run(
      new Date().toISOString(),
      'failed',
      details?.filesProcessed ?? 0,
      details?.filesTotal ?? 0,
      details?.chunksCreated ?? 0,
      details?.tokensIndexed ?? 0,
      details?.fetchStrategy ?? null,
      details?.lastFilePath ?? null,
      errorMessage,
      id,
    );
  }

  getLatest(dataSourceId: string): SyncRecord | undefined {
    const row = this.getLatestStmt.get(dataSourceId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  getByDataSource(dataSourceId: string): SyncRecord[] {
    const rows = this.getByDataSourceStmt.all(dataSourceId) as Record<string, unknown>[];
    return rows.map(mapRow);
  }
}

function mapRow(row: Record<string, unknown>): SyncRecord {
  return {
    id: row.id as string,
    dataSourceId: row.data_source_id as string,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | null,
    status: row.status as SyncRecord['status'],
    filesProcessed: row.files_processed as number,
    filesTotal: row.files_total as number,
    chunksCreated: row.chunks_created as number,
    tokensIndexed: row.tokens_indexed as number,
    errorMessage: row.error_message as string | null,
    commitSha: row.commit_sha as string | null,
    fetchStrategy: row.fetch_strategy as string | null,
    lastFilePath: row.last_file_path as string | null,
  };
}
