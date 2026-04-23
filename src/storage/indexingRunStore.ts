import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { FileTreeEntry } from '../sources/dataSource';

export interface IndexingRunRecord {
  id: string;
  dataSourceId: string;
  runKey: string;
  commitSha: string;
  status: 'running' | 'completed' | 'failed';
  totalFiles: number;
  fetchStrategy: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface IndexingRunFileRecord {
  runId: string;
  filePath: string;
  fileSha: string;
  fileSize: number;
  status: 'pending' | 'completed' | 'failed';
  chunkCount: number;
  tokenCount: number;
  errorMessage: string | null;
  updatedAt: string;
}

export interface IndexingRunSummary {
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  chunkCount: number;
  tokenCount: number;
}

export class IndexingRunStore {
  private readonly findReusableRunStmt: Database.Statement;
  private readonly insertRunStmt: Database.Statement;
  private readonly updateRunStatusStmt: Database.Statement;
  private readonly updateRunFetchStrategyStmt: Database.Statement;
  private readonly upsertRunFileStmt: Database.Statement;
  private readonly getPendingFilesStmt: Database.Statement;
  private readonly markCompletedStmt: Database.Statement;
  private readonly markFailedStmt: Database.Statement;
  private readonly summaryStmt: Database.Statement;
  private readonly getAllFilesStmt: Database.Statement;
  private readonly deleteRunsByDataSourceStmt: Database.Statement;
  private readonly deleteRunFilesByDataSourceStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.findReusableRunStmt = db.prepare(`
      SELECT *
      FROM indexing_runs
      WHERE data_source_id = ?
        AND run_key = ?
        AND status IN ('running', 'failed')
      ORDER BY started_at DESC
      LIMIT 1
    `);
    this.insertRunStmt = db.prepare(`
      INSERT INTO indexing_runs (
        id, data_source_id, run_key, commit_sha, status, total_files, started_at
      )
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `);
    this.updateRunStatusStmt = db.prepare(`
      UPDATE indexing_runs
      SET status = ?, completed_at = ?, fetch_strategy = COALESCE(?, fetch_strategy)
      WHERE id = ?
    `);
    this.updateRunFetchStrategyStmt = db.prepare(`
      UPDATE indexing_runs
      SET fetch_strategy = ?
      WHERE id = ?
    `);
    this.upsertRunFileStmt = db.prepare(`
      INSERT INTO indexing_run_files (
        run_id, file_path, file_sha, file_size, status, updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(run_id, file_path) DO UPDATE SET
        file_sha = excluded.file_sha,
        file_size = excluded.file_size
    `);
    this.getPendingFilesStmt = db.prepare(`
      SELECT *
      FROM indexing_run_files
      WHERE run_id = ?
        AND status != 'completed'
      ORDER BY file_path
    `);
    this.markCompletedStmt = db.prepare(`
      UPDATE indexing_run_files
      SET status = 'completed',
          chunk_count = ?,
          token_count = ?,
          error_message = NULL,
          updated_at = ?
      WHERE run_id = ?
        AND file_path = ?
    `);
    this.markFailedStmt = db.prepare(`
      UPDATE indexing_run_files
      SET status = 'failed',
          error_message = ?,
          updated_at = ?
      WHERE run_id = ?
        AND file_path = ?
    `);
    this.summaryStmt = db.prepare(`
      SELECT
        COUNT(*) AS total_files,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_files,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN chunk_count ELSE 0 END), 0) AS chunk_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN token_count ELSE 0 END), 0) AS token_count
      FROM indexing_run_files
      WHERE run_id = ?
    `);
    this.getAllFilesStmt = db.prepare(`
      SELECT *
      FROM indexing_run_files
      WHERE run_id = ?
      ORDER BY file_path
    `);
    this.deleteRunsByDataSourceStmt = db.prepare(`
      DELETE FROM indexing_runs
      WHERE data_source_id = ?
    `);
    this.deleteRunFilesByDataSourceStmt = db.prepare(`
      DELETE FROM indexing_run_files
      WHERE run_id IN (
        SELECT id FROM indexing_runs WHERE data_source_id = ?
      )
    `);
  }

  startOrResumeRun(
    dataSourceId: string,
    runKey: string,
    commitSha: string,
    files: FileTreeEntry[],
  ): IndexingRunRecord {
    const reusable = this.findReusableRun(dataSourceId, runKey);
    if (reusable) {
      this.syncManifest(reusable.id, files);
      return this.getRunById(reusable.id)!;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.insertRunStmt.run(id, dataSourceId, runKey, commitSha, files.length, now);
    this.syncManifest(id, files);
    return this.getRunById(id)!;
  }

  setFetchStrategy(runId: string, fetchStrategy: string): void {
    this.updateRunFetchStrategyStmt.run(fetchStrategy, runId);
  }

  completeRun(runId: string, fetchStrategy?: string): void {
    this.updateRunStatusStmt.run('completed', new Date().toISOString(), fetchStrategy ?? null, runId);
  }

  failRun(runId: string, fetchStrategy?: string): void {
    this.updateRunStatusStmt.run('failed', new Date().toISOString(), fetchStrategy ?? null, runId);
  }

  markFileCompleted(runId: string, filePath: string, chunkCount: number, tokenCount: number): void {
    this.markCompletedStmt.run(chunkCount, tokenCount, new Date().toISOString(), runId, filePath);
  }

  markFileFailed(runId: string, filePath: string, errorMessage: string): void {
    this.markFailedStmt.run(errorMessage, new Date().toISOString(), runId, filePath);
  }

  getPendingFiles(runId: string): FileTreeEntry[] {
    const rows = this.getPendingFilesStmt.all(runId) as Record<string, unknown>[];
    return rows.map(mapRunFileToTreeEntry);
  }

  getAllFiles(runId: string): IndexingRunFileRecord[] {
    const rows = this.getAllFilesStmt.all(runId) as Record<string, unknown>[];
    return rows.map(mapRunFile);
  }

  getSummary(runId: string): IndexingRunSummary {
    const row = this.summaryStmt.get(runId) as {
      total_files: number;
      completed_files: number;
      failed_files: number;
      chunk_count: number;
      token_count: number;
    };
    return {
      totalFiles: row.total_files,
      completedFiles: row.completed_files,
      failedFiles: row.failed_files,
      chunkCount: row.chunk_count,
      tokenCount: row.token_count,
    };
  }

  deleteByDataSource(dataSourceId: string): void {
    const tx = this.db.transaction((id: string) => {
      this.deleteRunFilesByDataSourceStmt.run(id);
      this.deleteRunsByDataSourceStmt.run(id);
    });
    tx(dataSourceId);
  }

  private findReusableRun(dataSourceId: string, runKey: string): IndexingRunRecord | undefined {
    const row = this.findReusableRunStmt.get(dataSourceId, runKey) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : undefined;
  }

  private getRunById(runId: string): IndexingRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM indexing_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : undefined;
  }

  private syncManifest(runId: string, files: FileTreeEntry[]): void {
    const tx = this.db.transaction((entries: FileTreeEntry[]) => {
      for (const entry of entries) {
        this.upsertRunFileStmt.run(
          runId,
          entry.path,
          entry.sha,
          entry.size,
          new Date().toISOString(),
        );
      }
      this.db.prepare(
        'UPDATE indexing_runs SET total_files = ? WHERE id = ?',
      ).run(entries.length, runId);
    });
    tx(files);
  }
}

function mapRun(row: Record<string, unknown>): IndexingRunRecord {
  return {
    id: row.id as string,
    dataSourceId: row.data_source_id as string,
    runKey: row.run_key as string,
    commitSha: row.commit_sha as string,
    status: row.status as IndexingRunRecord['status'],
    totalFiles: row.total_files as number,
    fetchStrategy: row.fetch_strategy as string | null,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | null,
  };
}

function mapRunFile(row: Record<string, unknown>): IndexingRunFileRecord {
  return {
    runId: row.run_id as string,
    filePath: row.file_path as string,
    fileSha: row.file_sha as string,
    fileSize: row.file_size as number,
    status: row.status as IndexingRunFileRecord['status'],
    chunkCount: row.chunk_count as number,
    tokenCount: row.token_count as number,
    errorMessage: row.error_message as string | null,
    updatedAt: row.updated_at as string,
  };
}

function mapRunFileToTreeEntry(row: Record<string, unknown>): FileTreeEntry {
  return {
    path: row.file_path as string,
    sha: row.file_sha as string,
    size: row.file_size as number,
    type: 'blob',
  };
}
