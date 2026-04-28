import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database';
import { Retriever } from '../../src/retrieval/retriever';
import { ChunkStore } from '../../src/storage/chunkStore';
import { DataSourceStore } from '../../src/storage/dataSourceStore';
import { EmbeddingStore } from '../../src/storage/embeddingStore';
import { loadOpenAIResponsesConfigFromEnv } from './openaiResponses';
import { runSearchAnswerabilityEvaluation } from './searchAnswerabilityHarness';
import { loadSearchEvalDataset, seedSearchEvalCorpus } from './searchEvalHarness';

const config = loadOpenAIResponsesConfigFromEnv();
const describeIfOpenAI = config ? describe : describe.skip;

describeIfOpenAI('search answerability evaluation', () => {
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

  it('produces an answerability artifact and summary', async () => {
    const summary = await runSearchAnswerabilityEvaluation(retriever, config!);

    expect(summary.dataset.promptCount).toBeGreaterThan(0);
    expect(summary.byTopK['1']).toBeDefined();
    expect(summary.byTopK['3']).toBeDefined();
    expect(summary.byTopK['5']).toBeDefined();
    expect(summary.prompts.length).toBeGreaterThanOrEqual(summary.dataset.promptCount);
    expect(summary.prompts[0].answer.answer.length).toBeGreaterThan(0);
  }, 120_000);
});
