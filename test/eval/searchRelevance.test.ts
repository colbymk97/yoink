import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database';
import { Retriever } from '../../src/retrieval/retriever';
import { ChunkStore } from '../../src/storage/chunkStore';
import { DataSourceStore } from '../../src/storage/dataSourceStore';
import { EmbeddingStore } from '../../src/storage/embeddingStore';
import {
  collapseResultsToFiles,
  formatSearchEvalReport,
  loadSearchEvalDataset,
  makeSearchEvalProvider,
  runSearchEvaluation,
  seedSearchEvalCorpus,
  SearchEvalDataset,
  SearchEvalSummary,
} from './searchEvalHarness';

describe('search relevance benchmark', () => {
  let db: Database.Database;
  let retriever: Retriever;
  let chunkStore: ChunkStore;
  let dataset: SearchEvalDataset;
  let summary: SearchEvalSummary;

  beforeAll(async () => {
    dataset = loadSearchEvalDataset();
    db = openDatabase({ dimensions: dataset.corpus.dimensions });

    const dataSourceStore = new DataSourceStore(db);
    chunkStore = new ChunkStore(db);
    const embeddingStore = new EmbeddingStore(db);
    retriever = new Retriever(chunkStore, embeddingStore);

    seedSearchEvalCorpus(dataset.corpus, {
      dataSourceStore,
      chunkStore,
      embeddingStore,
    });

    summary = await runSearchEvaluation(retriever, dataset);
  });

  afterAll(() => {
    db?.close();
  });

  it('emits a human-readable report and JSON artifact', () => {
    const report = formatSearchEvalReport(summary);
    expect(report).toContain('Search relevance benchmark');
    expect(report).toContain('semantic-paraphrase');
    expect(report).toContain('workflow-action');
    expect(report).toContain('diversity (hybrid payload)');
    console.log(`\n${report}`);

    expect(existsSync(summary.artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(summary.artifactPath, 'utf8')) as SearchEvalSummary;
    expect(artifact.dataset.queryCount).toBe(dataset.queries.length);
    expect(artifact.modes.hybrid.overall.recallAt5).toBe(summary.modes.hybrid.overall.recallAt5);
  });

  it('keeps benchmark diagnostics and expected dataset counts', () => {
    expect(summary.dataset.queryCount).toBe(46);
    expect(summary.dataset.fileCount).toBe(18);
    expect(summary.dataset.chunkCount).toBe(19);
    expect(summary.dataset.queryCountByIntent['semantic-paraphrase']).toBe(10);
    expect(summary.dataset.queryCountByIntent['identifier-exact']).toBe(8);
    expect(summary.dataset.queryCountByIntent['path-structure']).toBe(6);
    expect(summary.dataset.queryCountByIntent['docs-howto']).toBe(7);
    expect(summary.dataset.queryCountByIntent['workflow-action']).toBe(7);
    expect(summary.dataset.queryCountByIntent['implementation-location']).toBe(4);
    expect(summary.dataset.queryCountByIntent['change-impact']).toBe(4);

    const hybridQuery = summary.modes.hybrid.queries.find((query) => query.id === 'semantic-01');
    expect(hybridQuery?.topFiles[0].diagnostics?.mode).toBe('hybrid');
    expect(hybridQuery?.topResultType).toBe('code');
    expect(hybridQuery?.diversity.duplicateFileCrowdingCountTop5).toBeGreaterThan(0);
  });

  it('shows hybrid search beating vector-only on exact identifiers', () => {
    const hybrid = summary.modes.hybrid.byIntent['identifier-exact'];
    const vectorOnly = summary.modes['vector-only'].byIntent['identifier-exact'];

    expect(hybrid.mrrAt10).toBeGreaterThan(vectorOnly.mrrAt10);
    expect(hybrid.recallAt1).toBeGreaterThan(vectorOnly.recallAt1);
  });

  it('shows hybrid search beating FTS-only on semantic paraphrases', () => {
    const hybrid = summary.modes.hybrid.byIntent['semantic-paraphrase'];
    const ftsOnly = summary.modes['fts-only'].byIntent['semantic-paraphrase'];

    expect(hybrid.mrrAt10).toBeGreaterThan(ftsOnly.mrrAt10);
    expect(hybrid.recallAt5).toBeGreaterThan(ftsOnly.recallAt5);
  });

  it('shows path boost improving structure-oriented queries without hurting top-5 success', () => {
    const hybrid = summary.modes.hybrid.byIntent['path-structure'];
    const hybridNoPath = summary.modes['hybrid-no-path'].byIntent['path-structure'];

    expect(hybrid.mrrAt10).toBeGreaterThan(hybridNoPath.mrrAt10);
    expect(summary.modes.hybrid.overall.successAt5).toBeGreaterThanOrEqual(
      summary.modes['hybrid-no-path'].overall.successAt5 - 0.03,
    );
  });

  it('collapses duplicate chunks from the same file before scoring file relevance', async () => {
    const query = dataset.queries.find((entry) => entry.id === 'semantic-01');
    expect(query).toBeDefined();

    const repoByDataSourceId = new Map(
      dataset.corpus.dataSources.map((source) => [source.id, `${source.owner}/${source.repo}`]),
    );
    const results = await retriever.search(
      query!.query,
      [],
      makeSearchEvalProvider(dataset),
      10,
      { mode: 'hybrid', includeDiagnostics: true },
    );

    const topThreePaths = results.slice(0, 3).map((result) => result.chunk.filePath);
    expect(topThreePaths[0]).toBe('src/auth/sessionManager.ts');
    expect(
      topThreePaths.filter((filePath) => filePath === 'src/auth/sessionManager.ts').length,
    ).toBe(2);
    expect(topThreePaths).toContain('src/security/tokenVerifier.ts');

    const collapsed = collapseResultsToFiles(results, repoByDataSourceId);
    expect(collapsed.slice(0, 2).map((result) => result.filePath)).toEqual([
      'src/auth/sessionManager.ts',
      'src/security/tokenVerifier.ts',
    ]);
  });

  it('tracks duplicate crowding before rerank and improved file diversity after rerank', () => {
    const semanticQuery = summary.modes.hybrid.queries.find((query) => query.id === 'semantic-01');
    expect(semanticQuery).toBeDefined();
    expect(semanticQuery?.diversity.rawUniqueFilesInTop3).toBeLessThan(
      semanticQuery!.diversity.uniqueFilesInTop3,
    );
    expect(semanticQuery?.diversity.duplicateFileCrowdingCountTop5).toBeGreaterThan(0);
    expect(semanticQuery?.diversity.firstPageDuplicateShare).toBeLessThanOrEqual(
      semanticQuery!.diversity.rawFirstPageDuplicateShare,
    );
  });

  it('surfaces duplicate-crowding queries as a measurable weakness bucket', () => {
    const duplicateCrowding = summary.modes.hybrid.diversityByFailureBucket['duplicate-crowding'];
    expect(duplicateCrowding).toBeDefined();
    expect(duplicateCrowding.duplicateFileCrowdingCountTop5).toBeGreaterThan(0);
    expect(duplicateCrowding.uniqueFilesInTop5).toBeGreaterThanOrEqual(
      duplicateCrowding.rawUniqueFilesInTop5,
    );

    const crowdedQueries = summary.weaknessReport.topDuplicateCrowdingQueries.map((query) => query.queryId);
    expect(crowdedQueries).toContain('semantic-01');
    expect(crowdedQueries).toContain('implementation-01');
  });
});
