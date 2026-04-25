import Database from 'better-sqlite3';

export interface ChunkRecord {
  id: string;
  dataSourceId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
}

export interface FileStats {
  filePath: string;
  chunkCount: number;
  tokenCount: number;
}

export interface DataSourceStats {
  fileCount: number;
  chunkCount: number;
  totalTokens: number;
}

export class ChunkStore {
  private readonly insertStmt: Database.Statement;
  private readonly deleteByDataSourceStmt: Database.Statement;
  private readonly deleteByFileStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly getByDataSourceStmt: Database.Statement;
  private readonly countByDataSourceStmt: Database.Statement;
  private readonly fileStatsStmt: Database.Statement;
  private readonly dataSourceStatsStmt: Database.Statement;
  private readonly ftsInsertStmt: Database.Statement;
  private readonly ftsDeleteByDataSourceStmt: Database.Statement;
  private readonly ftsDeleteByFileStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO chunks (id, data_source_id, file_path, start_line, end_line, content, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteByDataSourceStmt = db.prepare('DELETE FROM chunks WHERE data_source_id = ?');
    this.deleteByFileStmt = db.prepare(
      'DELETE FROM chunks WHERE data_source_id = ? AND file_path = ?',
    );
    this.ftsInsertStmt = db.prepare(
      'INSERT INTO chunks_fts (chunk_id, data_source_id, file_path, content) VALUES (?, ?, ?, ?)',
    );
    this.ftsDeleteByDataSourceStmt = db.prepare(
      'DELETE FROM chunks_fts WHERE data_source_id = ?',
    );
    this.ftsDeleteByFileStmt = db.prepare(
      'DELETE FROM chunks_fts WHERE data_source_id = ? AND file_path = ?',
    );
    this.getByIdStmt = db.prepare('SELECT * FROM chunks WHERE id = ?');
    this.getByDataSourceStmt = db.prepare('SELECT * FROM chunks WHERE data_source_id = ?');
    this.countByDataSourceStmt = db.prepare(
      'SELECT COUNT(*) as count FROM chunks WHERE data_source_id = ?',
    );
    this.fileStatsStmt = db.prepare(`
      SELECT file_path, COUNT(*) as chunk_count, SUM(token_count) as token_count
      FROM chunks WHERE data_source_id = ?
      GROUP BY file_path ORDER BY file_path
    `);
    this.dataSourceStatsStmt = db.prepare(`
      SELECT COUNT(DISTINCT file_path) as file_count,
             COUNT(*) as chunk_count,
             COALESCE(SUM(token_count), 0) as total_tokens
      FROM chunks WHERE data_source_id = ?
    `);
  }

  insert(chunk: ChunkRecord): void {
    this.insertStmt.run(
      chunk.id,
      chunk.dataSourceId,
      chunk.filePath,
      chunk.startLine,
      chunk.endLine,
      chunk.content,
      chunk.tokenCount,
    );
    this.ftsInsertStmt.run(chunk.id, chunk.dataSourceId, chunk.filePath, chunk.content);
  }

  insertMany(chunks: ChunkRecord[]): void {
    const tx = this.db.transaction((items: ChunkRecord[]) => {
      for (const chunk of items) {
        this.insertStmt.run(
          chunk.id,
          chunk.dataSourceId,
          chunk.filePath,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.tokenCount,
        );
        this.ftsInsertStmt.run(chunk.id, chunk.dataSourceId, chunk.filePath, chunk.content);
      }
    });
    tx(chunks);
  }

  deleteByDataSource(dataSourceId: string): number {
    const result = this.deleteByDataSourceStmt.run(dataSourceId);
    this.ftsDeleteByDataSourceStmt.run(dataSourceId);
    return result.changes;
  }

  deleteByFile(dataSourceId: string, filePath: string): number {
    const result = this.deleteByFileStmt.run(dataSourceId, filePath);
    this.ftsDeleteByFileStmt.run(dataSourceId, filePath);
    return result.changes;
  }

  searchFts(
    query: string,
    dataSourceIds: string[],
    topK: number,
  ): Array<{ chunkId: string; bm25Score: number }> {
    const clean = sanitizeFtsQuery(query);
    if (!clean || dataSourceIds.length === 0) return [];

    const placeholders = dataSourceIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT chunk_id, -bm25(chunks_fts, 0.0, 0.0, 5.0, 1.0) AS score
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
        AND data_source_id IN (${placeholders})
      ORDER BY score DESC
      LIMIT ?
    `);
    const rows = stmt.all(clean, ...dataSourceIds, topK) as Array<{
      chunk_id: string;
      score: number;
    }>;
    return rows.map((r) => ({ chunkId: r.chunk_id, bm25Score: r.score }));
  }

  searchFtsAll(query: string, topK: number): Array<{ chunkId: string; bm25Score: number }> {
    const clean = sanitizeFtsQuery(query);
    if (!clean) return [];

    const stmt = this.db.prepare(`
      SELECT chunk_id, -bm25(chunks_fts, 0.0, 0.0, 5.0, 1.0) AS score
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `);
    const rows = stmt.all(clean, topK) as Array<{
      chunk_id: string;
      score: number;
    }>;
    return rows.map((r) => ({ chunkId: r.chunk_id, bm25Score: r.score }));
  }

  getById(id: string): ChunkRecord | undefined {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  getByDataSource(dataSourceId: string): ChunkRecord[] {
    const rows = this.getByDataSourceStmt.all(dataSourceId) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  getChunkIdsByDataSource(dataSourceId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM chunks WHERE data_source_id = ?')
      .all(dataSourceId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  getChunkIdsByFile(dataSourceId: string, filePath: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM chunks WHERE data_source_id = ? AND file_path = ?')
      .all(dataSourceId, filePath) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  countByDataSource(dataSourceId: string): number {
    const row = this.countByDataSourceStmt.get(dataSourceId) as { count: number };
    return row.count;
  }

  getFileStats(dataSourceId: string): FileStats[] {
    const rows = this.fileStatsStmt.all(dataSourceId) as Array<{
      file_path: string;
      chunk_count: number;
      token_count: number;
    }>;
    return rows.map((r) => ({
      filePath: r.file_path,
      chunkCount: r.chunk_count,
      tokenCount: r.token_count,
    }));
  }

  getDataSourceStats(dataSourceId: string): DataSourceStats {
    const row = this.dataSourceStatsStmt.get(dataSourceId) as {
      file_count: number;
      chunk_count: number;
      total_tokens: number;
    };
    return {
      fileCount: row.file_count,
      chunkCount: row.chunk_count,
      totalTokens: row.total_tokens,
    };
  }
}

function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ''))
    .filter((t) => t.length >= 2)
    .join(' ');
}

function mapRow(row: Record<string, unknown>): ChunkRecord {
  return {
    id: row.id as string,
    dataSourceId: row.data_source_id as string,
    filePath: row.file_path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    content: row.content as string,
    tokenCount: row.token_count as number,
  };
}
