import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../../src/storage/database';
import { ChunkStore, ChunkRecord } from '../../../src/storage/chunkStore';
import { DataSourceStore } from '../../../src/storage/dataSourceStore';

describe('ChunkStore', () => {
  let db: Database.Database;
  let chunkStore: ChunkStore;
  let dsStore: DataSourceStore;

  beforeEach(() => {
    db = openDatabase();
    chunkStore = new ChunkStore(db);
    dsStore = new DataSourceStore(db);
    dsStore.insert('ds1', 'owner', 'repo', 'main');
    dsStore.insert('ds2', 'owner', 'repo2', 'main');
  });

  afterEach(() => {
    db.close();
  });

  function makeChunk(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
    return {
      id: 'chunk-1',
      dataSourceId: 'ds1',
      filePath: 'src/index.ts',
      startLine: 1,
      endLine: 10,
      content: 'const x = 1;',
      tokenCount: 5,
      ...overrides,
    };
  }

  it('inserts and retrieves a chunk by id', () => {
    const chunk = makeChunk();
    chunkStore.insert(chunk);

    const result = chunkStore.getById('chunk-1');
    expect(result).toEqual(chunk);
  });

  it('returns undefined for non-existent id', () => {
    expect(chunkStore.getById('nope')).toBeUndefined();
  });

  it('inserts many chunks in a transaction', () => {
    const chunks = [
      makeChunk({ id: 'c1', filePath: 'a.ts' }),
      makeChunk({ id: 'c2', filePath: 'b.ts' }),
      makeChunk({ id: 'c3', filePath: 'c.ts' }),
    ];
    chunkStore.insertMany(chunks);

    const results = chunkStore.getByDataSource('ds1');
    expect(results).toHaveLength(3);
  });

  it('retrieves chunks by data source', () => {
    chunkStore.insert(makeChunk({ id: 'c1', dataSourceId: 'ds1' }));
    chunkStore.insert(makeChunk({ id: 'c2', dataSourceId: 'ds2' }));
    chunkStore.insert(makeChunk({ id: 'c3', dataSourceId: 'ds1' }));

    const ds1Chunks = chunkStore.getByDataSource('ds1');
    expect(ds1Chunks).toHaveLength(2);
    expect(ds1Chunks.map((c) => c.id).sort()).toEqual(['c1', 'c3']);
  });

  it('deletes all chunks for a data source', () => {
    chunkStore.insert(makeChunk({ id: 'c1', dataSourceId: 'ds1' }));
    chunkStore.insert(makeChunk({ id: 'c2', dataSourceId: 'ds1' }));
    chunkStore.insert(makeChunk({ id: 'c3', dataSourceId: 'ds2' }));

    const deleted = chunkStore.deleteByDataSource('ds1');
    expect(deleted).toBe(2);
    expect(chunkStore.getByDataSource('ds1')).toHaveLength(0);
    expect(chunkStore.getByDataSource('ds2')).toHaveLength(1);
  });

  it('deletes chunks for a specific file', () => {
    chunkStore.insert(makeChunk({ id: 'c1', filePath: 'a.ts' }));
    chunkStore.insert(makeChunk({ id: 'c2', filePath: 'b.ts' }));
    chunkStore.insert(makeChunk({ id: 'c3', filePath: 'a.ts' }));

    const deleted = chunkStore.deleteByFile('ds1', 'a.ts');
    expect(deleted).toBe(2);
    expect(chunkStore.getByDataSource('ds1')).toHaveLength(1);
    expect(chunkStore.getById('c2')).toBeDefined();
  });

  it('gets chunk ids by data source', () => {
    chunkStore.insert(makeChunk({ id: 'c1' }));
    chunkStore.insert(makeChunk({ id: 'c2' }));

    const ids = chunkStore.getChunkIdsByDataSource('ds1');
    expect(ids.sort()).toEqual(['c1', 'c2']);
  });

  it('gets chunk ids by file', () => {
    chunkStore.insert(makeChunk({ id: 'c1', filePath: 'a.ts' }));
    chunkStore.insert(makeChunk({ id: 'c2', filePath: 'b.ts' }));
    chunkStore.insert(makeChunk({ id: 'c3', filePath: 'a.ts' }));

    const ids = chunkStore.getChunkIdsByFile('ds1', 'a.ts');
    expect(ids.sort()).toEqual(['c1', 'c3']);
  });

  it('counts chunks by data source', () => {
    chunkStore.insert(makeChunk({ id: 'c1' }));
    chunkStore.insert(makeChunk({ id: 'c2' }));

    expect(chunkStore.countByDataSource('ds1')).toBe(2);
    expect(chunkStore.countByDataSource('ds2')).toBe(0);
  });

  it('deleteByDataSource removes all chunks for that source', () => {
    chunkStore.insert(makeChunk({ id: 'c1', dataSourceId: 'ds1' }));
    chunkStore.insert(makeChunk({ id: 'c2', dataSourceId: 'ds1' }));

    chunkStore.deleteByDataSource('ds1');
    expect(chunkStore.getByDataSource('ds1')).toHaveLength(0);
  });

  it('getFileStats returns per-file chunk and token counts', () => {
    chunkStore.insert(makeChunk({ id: 'c1', filePath: 'a.ts', tokenCount: 10 }));
    chunkStore.insert(makeChunk({ id: 'c2', filePath: 'a.ts', tokenCount: 20 }));
    chunkStore.insert(makeChunk({ id: 'c3', filePath: 'b.ts', tokenCount: 15 }));

    const stats = chunkStore.getFileStats('ds1');
    expect(stats).toHaveLength(2);
    expect(stats[0]).toEqual({ filePath: 'a.ts', chunkCount: 2, tokenCount: 30 });
    expect(stats[1]).toEqual({ filePath: 'b.ts', chunkCount: 1, tokenCount: 15 });
  });

  it('getFileStats returns empty array for unknown data source', () => {
    expect(chunkStore.getFileStats('nonexistent')).toEqual([]);
  });

  it('getFileStats returns results sorted by file path', () => {
    chunkStore.insert(makeChunk({ id: 'c1', filePath: 'src/z.ts', tokenCount: 5 }));
    chunkStore.insert(makeChunk({ id: 'c2', filePath: 'src/a.ts', tokenCount: 5 }));
    chunkStore.insert(makeChunk({ id: 'c3', filePath: 'lib/b.ts', tokenCount: 5 }));

    const stats = chunkStore.getFileStats('ds1');
    expect(stats.map((s) => s.filePath)).toEqual(['lib/b.ts', 'src/a.ts', 'src/z.ts']);
  });

  it('getDataSourceStats returns aggregate counts', () => {
    chunkStore.insert(makeChunk({ id: 'c1', filePath: 'a.ts', tokenCount: 10 }));
    chunkStore.insert(makeChunk({ id: 'c2', filePath: 'a.ts', tokenCount: 20 }));
    chunkStore.insert(makeChunk({ id: 'c3', filePath: 'b.ts', tokenCount: 15 }));

    const stats = chunkStore.getDataSourceStats('ds1');
    expect(stats).toEqual({ fileCount: 2, chunkCount: 3, totalTokens: 45 });
  });

  it('getDataSourceStats returns zeros for unknown data source', () => {
    const stats = chunkStore.getDataSourceStats('nonexistent');
    expect(stats).toEqual({ fileCount: 0, chunkCount: 0, totalTokens: 0 });
  });
});
