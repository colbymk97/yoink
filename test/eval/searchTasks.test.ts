import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database';
import { Retriever } from '../../src/retrieval/retriever';
import { ChunkStore } from '../../src/storage/chunkStore';
import { DataSourceStore } from '../../src/storage/dataSourceStore';
import { EmbeddingStore } from '../../src/storage/embeddingStore';
import { loadOpenAIResponsesConfigFromEnv } from './openaiResponses';
import { runSearchTaskEvaluation } from './searchTaskHarness';
import { loadSearchEvalDataset, seedSearchEvalCorpus } from './searchEvalHarness';

const config = loadOpenAIResponsesConfigFromEnv();
const describeIfOpenAI = config ? describe : describe.skip;

describeIfOpenAI('search task evaluation', () => {
  let db: Database.Database;
  let retriever: Retriever;

  beforeAll(() => {
    const dataset = loadSearchEvalDataset();
    db = openDatabase({ dimensions: dataset.corpus.dimensions });
    const dataSourceStore = new DataSourceStore(db);
    const chunkStore = new ChunkStore(db);
    const embeddingStore = new EmbeddingStore(db);
    retriever = new Retriever(chunkStore, embeddingStore);
    seedSearchEvalCorpus(dataset.corpus, {
      dataSourceStore,
      chunkStore,
      embeddingStore,
    });
  });

  afterAll(() => {
    db?.close();
  });

  it('produces a task-eval artifact and summary', async () => {
    const summary = await runSearchTaskEvaluation(retriever, config!);

    expect(summary.dataset.taskCount).toBeGreaterThan(0);
    expect(summary.tasks.length).toBe(summary.dataset.taskCount);
    expect(summary.tasks[0].searchTurns).toBe(1);
  }, 120_000);
});
