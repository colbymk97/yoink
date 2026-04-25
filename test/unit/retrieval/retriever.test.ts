import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../../src/storage/database';
import { ChunkStore, ChunkRecord } from '../../../src/storage/chunkStore';
import { EmbeddingStore } from '../../../src/storage/embeddingStore';
import { DataSourceStore } from '../../../src/storage/dataSourceStore';
import { Retriever } from '../../../src/retrieval/retriever';
import { EmbeddingProvider } from '../../../src/embedding/embeddingProvider';
import Database from 'better-sqlite3';

const DIMS = 4;

function makeProvider(embedResult: number[][]): EmbeddingProvider {
  return {
    id: 'test',
    maxBatchSize: 100,
    maxInputTokens: 8000,
    dimensions: DIMS,
    embed: async (_texts: string[]) => embedResult,
    countTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

describe('Retriever', () => {
  let db: Database.Database;
  let chunkStore: ChunkStore;
  let embeddingStore: EmbeddingStore;
  let dsStore: DataSourceStore;
  let retriever: Retriever;

  beforeEach(() => {
    db = openDatabase({ dimensions: DIMS });
    chunkStore = new ChunkStore(db);
    embeddingStore = new EmbeddingStore(db);
    dsStore = new DataSourceStore(db);
    retriever = new Retriever(chunkStore, embeddingStore);

    // Seed data
    dsStore.insert('ds-1', 'owner', 'repo', 'main');
    dsStore.insert('ds-2', 'owner', 'repo2', 'main');

    const chunks: ChunkRecord[] = [
      { id: 'c1', dataSourceId: 'ds-1', filePath: 'a.ts', startLine: 1, endLine: 5, content: 'function add(a, b) { return a + b; }', tokenCount: 10 },
      { id: 'c2', dataSourceId: 'ds-1', filePath: 'b.ts', startLine: 1, endLine: 3, content: 'const x = 42;', tokenCount: 5 },
      { id: 'c3', dataSourceId: 'ds-2', filePath: 'c.ts', startLine: 1, endLine: 10, content: 'class Foo {}', tokenCount: 4 },
    ];

    chunkStore.insertMany(chunks);

    // Insert embeddings — make c1 closest to query [1,0,0,0]
    embeddingStore.insert('c1', [0.9, 0.1, 0.0, 0.0]);
    embeddingStore.insert('c2', [0.1, 0.9, 0.0, 0.0]);
    embeddingStore.insert('c3', [0.0, 0.0, 0.9, 0.1]);
  });

  afterEach(() => {
    db.close();
  });

  it('returns ranked results for a query', async () => {
    const provider = makeProvider([[1, 0, 0, 0]]);
    const results = await retriever.search('add function', ['ds-1', 'ds-2'], provider, 10);

    expect(results.length).toBe(3);
    // c1 should be closest to [1,0,0,0]
    expect(results[0].chunk.id).toBe('c1');
  });

  it('scopes results to specified data source IDs', async () => {
    const provider = makeProvider([[0, 0, 0.9, 0.1]]);
    const results = await retriever.search('class', ['ds-2'], provider, 10);

    expect(results.length).toBe(1);
    expect(results[0].chunk.id).toBe('c3');
  });

  it('searches all data sources when dataSourceIds is empty', async () => {
    const provider = makeProvider([[1, 0, 0, 0]]);
    const results = await retriever.search('query', [], provider, 10);

    expect(results.length).toBe(3);
  });

  it('uses FTS matches when searching all data sources', async () => {
    const provider = makeProvider([[0, 0, 0, 1]]);
    const results = await retriever.search('Foo', [], provider, 10);
    expect(results.map((r) => r.chunk.id)).toContain('c3');
  });

  it('respects topK limit', async () => {
    const provider = makeProvider([[1, 0, 0, 0]]);
    const results = await retriever.search('query', [], provider, 1);

    expect(results.length).toBe(1);
  });

  it('returns empty array when no embeddings exist', async () => {
    // New empty DB
    const emptyDb = openDatabase({ dimensions: DIMS });
    const emptyChunkStore = new ChunkStore(emptyDb);
    const emptyEmbeddingStore = new EmbeddingStore(emptyDb);
    const emptyRetriever = new Retriever(emptyChunkStore, emptyEmbeddingStore);

    const provider = makeProvider([[1, 0, 0, 0]]);
    const results = await emptyRetriever.search('query', [], provider, 10);

    expect(results).toEqual([]);
    emptyDb.close();
  });

  it('hydrates chunk data in results', async () => {
    const provider = makeProvider([[0.9, 0.1, 0, 0]]);
    const results = await retriever.search('query', ['ds-1'], provider, 1);

    expect(results[0].chunk.filePath).toBe('a.ts');
    expect(results[0].chunk.content).toContain('function add');
    expect(results[0].chunk.startLine).toBe(1);
    expect(results[0].chunk.endLine).toBe(5);
    expect(typeof results[0].distance).toBe('number');
  });

  it('skips stale embedding rows whose chunk has been deleted', async () => {
    chunkStore.deleteByFile('ds-1', 'a.ts');

    const provider = makeProvider([[0.9, 0.1, 0, 0]]);
    const results = await retriever.search('query', [], provider, 10);

    expect(results.map((r) => r.chunk.id)).not.toContain('c1');
    expect(results.map((r) => r.chunk.id).sort()).toEqual(['c2', 'c3']);
  });

  it('surfaces FTS-only matches (no vector match) in results', async () => {
    // c2 content is "const x = 42" — poor vector match for [1,0,0,0] but exact keyword match
    const provider = makeProvider([[1, 0, 0, 0]]);
    const results = await retriever.search('const', ['ds-1'], provider, 10);
    const ids = results.map((r) => r.chunk.id);
    expect(ids).toContain('c2');
  });

  it('ranks results appearing in both vector and FTS above single-signal results', async () => {
    // c1 has content "function add(a, b)" — matches both "add function" via FTS
    // and is vectorally closest to [1,0,0,0]
    const provider = makeProvider([[1, 0, 0, 0]]);
    const results = await retriever.search('add function', ['ds-1'], provider, 10);
    expect(results[0].chunk.id).toBe('c1');
  });

  it('applies path relevance boost', async () => {
    // All embeddings equidistant — path match should differentiate
    const provider = makeProvider([[0.5, 0.5, 0, 0]]);
    // Insert a chunk whose path contains the query token
    const dsStore2 = new DataSourceStore(db);
    dsStore2.insert('ds-path', 'owner', 'path-repo', 'main');
    const pathChunk: ChunkRecord = {
      id: 'path-chunk',
      dataSourceId: 'ds-path',
      filePath: 'src/authentication/service.ts',
      startLine: 1, endLine: 5,
      content: 'placeholder',
      tokenCount: 5,
    };
    chunkStore.insert(pathChunk);
    embeddingStore.insert('path-chunk', [0.5, 0.5, 0, 0]);

    const results = await retriever.search('authentication', ['ds-path'], provider, 10);
    expect(results[0].chunk.id).toBe('path-chunk');
  });
});
