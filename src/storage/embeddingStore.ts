import Database from 'better-sqlite3';

export interface EmbeddingSearchResult {
  chunkId: string;
  distance: number;
}

/**
 * Convert a number[] to the raw bytes sqlite-vec expects.
 * sqlite-vec reads FLOAT[N] columns as raw little-endian float32 blobs.
 */
function toVecBlob(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export class EmbeddingStore {
  private insertStmt!: Database.Statement;
  private deleteStmt!: Database.Statement;
  private clearStmt!: Database.Statement;
  private countStmt!: Database.Statement;
  private searchAllStmt!: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.prepareStatements();
  }

  refreshAfterSchemaChange(): void {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.insertStmt = this.db.prepare(
      'INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM embeddings WHERE chunk_id = ?');
    this.clearStmt = this.db.prepare('DELETE FROM embeddings');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM embeddings');
    this.searchAllStmt = this.db.prepare(`
      SELECT chunk_id, distance
      FROM embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `);
  }

  insert(chunkId: string, embedding: number[]): void {
    this.insertStmt.run(chunkId, toVecBlob(embedding));
  }

  insertMany(items: Array<{ chunkId: string; embedding: number[] }>): void {
    const tx = this.db.transaction((batch: typeof items) => {
      for (const item of batch) {
        this.insertStmt.run(item.chunkId, toVecBlob(item.embedding));
      }
    });
    tx(items);
  }

  deleteByChunkIds(chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.deleteStmt.run(id);
      }
    });
    tx(chunkIds);
  }

  clearAll(): void {
    this.clearStmt.run();
  }

  countAll(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }

  /**
   * Search for nearest neighbors, scoped to specific data sources.
   * Strategy: vec0 KNN search first (broad), then filter by data source
   * via a second pass. We over-fetch to account for filtering.
   */
  search(
    queryEmbedding: number[],
    dataSourceIds: string[],
    topK: number,
  ): EmbeddingSearchResult[] {
    if (dataSourceIds.length === 0) return [];

    const placeholders = dataSourceIds.map(() => '?').join(', ');

    // Two-step: KNN search, then filter via chunk table
    const stmt = this.db.prepare(`
      SELECT e.chunk_id, e.distance
      FROM embeddings e
      WHERE e.embedding MATCH ?
        AND e.chunk_id IN (
          SELECT id FROM chunks WHERE data_source_id IN (${placeholders})
        )
      ORDER BY e.distance
      LIMIT ?
    `);

    const blob = toVecBlob(queryEmbedding);
    const rows = stmt.all(blob, ...dataSourceIds, topK) as Array<{
      chunk_id: string;
      distance: number;
    }>;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      distance: r.distance,
    }));
  }

  /**
   * Search across all embeddings (no data source filtering).
   */
  searchAll(queryEmbedding: number[], topK: number): EmbeddingSearchResult[] {
    const blob = toVecBlob(queryEmbedding);
    const rows = this.searchAllStmt.all(blob, topK) as Array<{
      chunk_id: string;
      distance: number;
    }>;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      distance: r.distance,
    }));
  }
}
