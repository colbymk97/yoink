import Database from 'better-sqlite3';

export interface EmbeddingSearchResult {
  chunkId: string;
  distance: number;
}

export class EmbeddingStore {
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      'INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)',
    );
    this.deleteStmt = db.prepare('DELETE FROM embeddings WHERE chunk_id = ?');
  }

  insert(chunkId: string, embedding: number[]): void {
    this.insertStmt.run(chunkId, new Float32Array(embedding));
  }

  insertMany(items: Array<{ chunkId: string; embedding: number[] }>): void {
    const tx = this.db.transaction((batch: typeof items) => {
      for (const item of batch) {
        this.insert(item.chunkId, item.embedding);
      }
    });
    tx(items);
  }

  deleteByChunkIds(chunkIds: string[]): void {
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.deleteStmt.run(id);
      }
    });
    tx(chunkIds);
  }

  search(
    queryEmbedding: number[],
    dataSourceIds: string[],
    topK: number,
  ): EmbeddingSearchResult[] {
    // Build dynamic query with data source filtering via chunk join
    const placeholders = dataSourceIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT
        e.chunk_id,
        e.distance
      FROM embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      WHERE e.embedding MATCH ?
        AND c.data_source_id IN (${placeholders})
      ORDER BY e.distance
      LIMIT ?
    `);

    const rows = stmt.all(
      new Float32Array(queryEmbedding),
      ...dataSourceIds,
      topK,
    ) as Array<{ chunk_id: string; distance: number }>;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      distance: r.distance,
    }));
  }

  searchAll(queryEmbedding: number[], topK: number): EmbeddingSearchResult[] {
    const stmt = this.db.prepare(`
      SELECT chunk_id, distance
      FROM embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `);

    const rows = stmt.all(
      new Float32Array(queryEmbedding),
      topK,
    ) as Array<{ chunk_id: string; distance: number }>;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      distance: r.distance,
    }));
  }
}
