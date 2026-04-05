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

export class ChunkStore {
  private readonly insertStmt: Database.Statement;
  private readonly deleteByDataSourceStmt: Database.Statement;
  private readonly deleteByFileStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly getByDataSourceStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO chunks (id, data_source_id, file_path, start_line, end_line, content, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteByDataSourceStmt = db.prepare('DELETE FROM chunks WHERE data_source_id = ?');
    this.deleteByFileStmt = db.prepare(
      'DELETE FROM chunks WHERE data_source_id = ? AND file_path = ?',
    );
    this.getByIdStmt = db.prepare('SELECT * FROM chunks WHERE id = ?');
    this.getByDataSourceStmt = db.prepare('SELECT * FROM chunks WHERE data_source_id = ?');
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
  }

  insertMany(chunks: ChunkRecord[]): void {
    const tx = this.db.transaction((items: ChunkRecord[]) => {
      for (const chunk of items) {
        this.insert(chunk);
      }
    });
    tx(chunks);
  }

  deleteByDataSource(dataSourceId: string): void {
    this.deleteByDataSourceStmt.run(dataSourceId);
  }

  deleteByFile(dataSourceId: string, filePath: string): void {
    this.deleteByFileStmt.run(dataSourceId, filePath);
  }

  getById(id: string): ChunkRecord | undefined {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getByDataSource(dataSourceId: string): ChunkRecord[] {
    const rows = this.getByDataSourceStmt.all(dataSourceId) as Record<string, unknown>[];
    return rows.map(this.mapRow);
  }

  private mapRow(row: Record<string, unknown>): ChunkRecord {
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
}
