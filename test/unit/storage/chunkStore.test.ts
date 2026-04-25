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

  describe('searchFts', () => {
    beforeEach(() => {
      chunkStore.insertMany([
        makeChunk({ id: 'fts1', dataSourceId: 'ds1', filePath: 'src/auth/middleware.ts', content: 'function authenticate(token) { return verify(token); }' }),
        makeChunk({ id: 'fts2', dataSourceId: 'ds1', filePath: 'src/utils.ts', content: 'function parseRepoUrl(url) { return url.split("/"); }' }),
        makeChunk({ id: 'fts3', dataSourceId: 'ds2', filePath: 'src/parser.ts', content: 'function parseRepoUrl(url) { /* ds2 version */ }' }),
      ]);
    });

    it('returns results matching a keyword', () => {
      const results = chunkStore.searchFts('authenticate', ['ds1'], 10);
      expect(results.map((r) => r.chunkId)).toContain('fts1');
    });

    it('returns empty array for non-matching query', () => {
      const results = chunkStore.searchFts('xyznonexistenttoken', ['ds1'], 10);
      expect(results).toHaveLength(0);
    });

    it('filters by dataSourceIds', () => {
      const results = chunkStore.searchFts('parseRepoUrl', ['ds1'], 10);
      expect(results.map((r) => r.chunkId)).toContain('fts2');
      expect(results.map((r) => r.chunkId)).not.toContain('fts3');
    });

    it('returns empty array when dataSourceIds is empty', () => {
      const results = chunkStore.searchFts('authenticate', [], 10);
      expect(results).toHaveLength(0);
    });

    it('searchFtsAll searches across data sources when no scope is desired', () => {
      const results = chunkStore.searchFtsAll('parseRepoUrl', 10);
      expect(results.map((r) => r.chunkId).sort()).toEqual(['fts2', 'fts3']);
    });

    it('returns higher bm25Score for better matches', () => {
      const results = chunkStore.searchFts('parseRepoUrl', ['ds1', 'ds2'], 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].bm25Score).toBeGreaterThan(0);
    });

    it('removes FTS entries when deleteByDataSource is called', () => {
      chunkStore.deleteByDataSource('ds1');
      const results = chunkStore.searchFts('authenticate', ['ds1'], 10);
      expect(results).toHaveLength(0);
    });

    it('removes FTS entries when deleteByFile is called', () => {
      chunkStore.deleteByFile('ds1', 'src/auth/middleware.ts');
      const results = chunkStore.searchFts('authenticate', ['ds1'], 10);
      expect(results).toHaveLength(0);
    });

    it('deleteByFile leaves same-path FTS entries in other data sources intact', () => {
      chunkStore.insert(makeChunk({
        id: 'shared-ds1',
        dataSourceId: 'ds1',
        filePath: 'shared/readme.md',
        content: 'shared scoped deletion sentinel',
      }));
      chunkStore.insert(makeChunk({
        id: 'shared-ds2',
        dataSourceId: 'ds2',
        filePath: 'shared/readme.md',
        content: 'shared scoped deletion sentinel',
      }));

      chunkStore.deleteByFile('ds1', 'shared/readme.md');

      expect(chunkStore.searchFts('sentinel', ['ds1'], 10)).toEqual([]);
      expect(chunkStore.searchFts('sentinel', ['ds2'], 10).map((r) => r.chunkId)).toEqual([
        'shared-ds2',
      ]);
    });

    it('rolls back chunks and FTS rows when insertMany fails', () => {
      expect(() =>
        chunkStore.insertMany([
          makeChunk({ id: 'tx-ok', content: 'transaction rollback sentinel' }),
          makeChunk({ id: 'tx-ok', filePath: 'dupe.ts', content: 'duplicate id' }),
        ]),
      ).toThrow();

      expect(chunkStore.getById('tx-ok')).toBeUndefined();
      expect(chunkStore.searchFts('rollback', ['ds1'], 10)).toEqual([]);
    });

    it('boosts results where query term appears in file path', () => {
      // 'middleware' appears in the path of fts1 but not content of fts2
      const results = chunkStore.searchFts('middleware', ['ds1'], 10);
      const ids = results.map((r) => r.chunkId);
      expect(ids).toContain('fts1');
    });
  });
});
