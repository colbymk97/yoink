import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  classifySearchResultType,
  computeDuplicateShare,
  countDuplicateResultFiles,
  countUniqueResultFiles,
  rerankSearchResultsByFile,
  sortSearchResultsStable,
} from '../../src/tools/searchPayload';
import { RetrievalMode, RetrievalResult, RetrievalTuning, Retriever } from '../../src/retrieval/retriever';
import { DataSourceStore } from '../../src/storage/dataSourceStore';
import { EmbeddingStore } from '../../src/storage/embeddingStore';
import { ChunkStore } from '../../src/storage/chunkStore';
import {
  buildRepoMaps,
  loadSearchEvalDataset as loadDataset,
  makeSearchEvalProvider,
  SearchEvalDataset,
  SearchEvalFailureBucket,
  SearchEvalIntent,
  SearchEvalQuery,
  SearchEvalRepoType,
} from './searchEvalDataset';

export type { SearchEvalDataset } from './searchEvalDataset';
export { loadSearchEvalDataset, makeSearchEvalProvider } from './searchEvalDataset';

export interface SearchEvalMetrics {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  successAt5: number;
}

export interface SearchEvalFileResult {
  rank: number;
  repository: string;
  filePath: string;
  chunkId: string;
  startLine: number;
  endLine: number;
  score: number;
  diagnostics?: RetrievalResult['diagnostics'];
}

export interface SearchEvalQueryRun {
  id: string;
  repository: string | null;
  query: string;
  intent: SearchEvalIntent;
  failureBucket: SearchEvalFailureBucket | 'unclassified';
  metrics: SearchEvalMetrics;
  chunkHitAt5: boolean | null;
  duplicateFileCrowdingCount: number;
  topResultType: string | null;
  topResultRepoType: SearchEvalRepoType | null;
  diversity: SearchEvalDiversityDiagnostics;
  topFiles: SearchEvalFileResult[];
}

export interface SearchEvalDiversityDiagnostics {
  rawUniqueFilesInTop1: number;
  rawUniqueFilesInTop3: number;
  rawUniqueFilesInTop5: number;
  uniqueFilesInTop1: number;
  uniqueFilesInTop3: number;
  uniqueFilesInTop5: number;
  duplicateFileCrowdingCountTop5: number;
  duplicateFileCrowdingCountTop10: number;
  rawSecondaryRelevantFileInTop5: boolean | null;
  secondaryRelevantFileInTop5: boolean | null;
  rawFirstPageDuplicateShare: number;
  firstPageDuplicateShare: number;
}

export interface SearchEvalDiversitySummary {
  rawUniqueFilesInTop1: number;
  rawUniqueFilesInTop3: number;
  rawUniqueFilesInTop5: number;
  uniqueFilesInTop1: number;
  uniqueFilesInTop3: number;
  uniqueFilesInTop5: number;
  duplicateFileCrowdingCountTop5: number;
  duplicateFileCrowdingCountTop10: number;
  rawSecondaryRelevantFileInTop5: number;
  secondaryRelevantFileInTop5: number;
  rawFirstPageDuplicateShare: number;
  firstPageDuplicateShare: number;
}

export interface SearchEvalModeSummary {
  overall: SearchEvalMetrics;
  byIntent: Record<SearchEvalIntent, SearchEvalMetrics>;
  byFailureBucket: Record<string, SearchEvalMetrics>;
  byRepoType: Record<string, SearchEvalMetrics>;
  diversity: SearchEvalDiversitySummary;
  diversityByIntent: Record<SearchEvalIntent, SearchEvalDiversitySummary>;
  diversityByFailureBucket: Record<string, SearchEvalDiversitySummary>;
  queries: SearchEvalQueryRun[];
}

export interface SearchEvalWeaknessReport {
  topFailedIntents: Array<{ intent: string; recallAt1Gap: number }>;
  topFailedRepositories: Array<{ repository: string; misses: number }>;
  topMisleadingResultTypes: Array<{ resultType: string; count: number }>;
  topPathPenaltyQueries: Array<{ queryId: string; recallAt1Gap: number }>;
  topDuplicateCrowdingQueries: Array<{
    queryId: string;
    duplicateFileCrowdingCountTop5: number;
    secondaryRelevantFileInTop5: boolean | null;
  }>;
}

export interface SearchEvalSummary {
  generatedAt: string;
  artifactPath: string;
  dataset: {
    dimensions: number;
    dataSourceCount: number;
    fileCount: number;
    chunkCount: number;
    queryCount: number;
    queryCountByIntent: Record<SearchEvalIntent, number>;
    repoCountByType: Record<string, number>;
  };
  modes: Record<string, SearchEvalModeSummary>;
  weaknessReport: SearchEvalWeaknessReport;
}

export interface SearchEvalRunConfig {
  label: string;
  mode: RetrievalMode;
  topK?: number;
  tuning?: Partial<RetrievalTuning>;
}

const INTENTS: SearchEvalIntent[] = [
  'semantic-paraphrase',
  'identifier-exact',
  'path-structure',
  'docs-howto',
  'workflow-action',
  'implementation-location',
  'change-impact',
];

const DEFAULT_RUNS: SearchEvalRunConfig[] = [
  { label: 'vector-only', mode: 'vector-only' },
  { label: 'fts-only', mode: 'fts-only' },
  { label: 'hybrid-no-path', mode: 'hybrid-no-path' },
  { label: 'hybrid', mode: 'hybrid' },
];

const DEFAULT_TOP_K = 10;

export const SEARCH_RELEVANCE_ARTIFACT_PATH = resolve(
  __dirname,
  '../../test-results/search-relevance-summary.json',
);

export function seedSearchEvalCorpus(
  corpus: SearchEvalDataset['corpus'],
  stores: {
    dataSourceStore: DataSourceStore;
    chunkStore: ChunkStore;
    embeddingStore: EmbeddingStore;
  },
): void {
  for (const source of corpus.dataSources) {
    stores.dataSourceStore.insert(source.id, source.owner, source.repo, source.branch);
  }

  stores.chunkStore.insertMany(corpus.chunks);
  for (const chunk of corpus.chunks) {
    stores.embeddingStore.insert(chunk.id, chunk.embedding);
  }
}

export async function runSearchEvaluation(
  retriever: Retriever,
  dataset: SearchEvalDataset = loadDataset(),
  runConfigs: SearchEvalRunConfig[] = DEFAULT_RUNS,
): Promise<SearchEvalSummary> {
  const provider = makeSearchEvalProvider(dataset);
  const { repoByDataSourceId, dataSourceIdByRepo, repoTypeByRepo } = buildRepoMaps(dataset);

  const modes = Object.fromEntries(
    await Promise.all(
      runConfigs.map(async (runConfig) => {
        const queries: SearchEvalQueryRun[] = [];
        const topK = runConfig.topK ?? DEFAULT_TOP_K;

        for (const query of dataset.queries) {
          const dataSourceIds = resolveQueryScope(query.repository, dataSourceIdByRepo);
          const searchResults = await retriever.search(
            query.query,
            dataSourceIds,
            provider,
            topK,
            {
              mode: runConfig.mode,
              includeDiagnostics: true,
              tuning: runConfig.tuning,
            },
          );
          const rawResults = sortSearchResultsStable(searchResults);
          const returnedResults = rerankSearchResultsByFile(rawResults);
          const topFiles = collapseResultsToFiles(rawResults, repoByDataSourceId);
          const metrics = scoreFileRanking(query, topFiles, topK);
          const diversity = scoreFileDiversity(
            query,
            rawResults,
            returnedResults,
            repoByDataSourceId,
          );
          const topResult = topFiles[0];
          queries.push({
            id: query.id,
            repository: query.repository,
            query: query.query,
            intent: query.intent,
            failureBucket: query.failureBucket ?? 'unclassified',
            metrics,
            chunkHitAt5: scoreChunkHitAt5(query, rawResults),
            duplicateFileCrowdingCount: diversity.duplicateFileCrowdingCountTop5,
            topResultType: topResult ? classifySearchResultType(topResult.filePath) : null,
            topResultRepoType: topResult
              ? (repoTypeByRepo.get(topResult.repository) ?? null)
              : null,
            diversity,
            topFiles: topFiles.slice(0, topK),
          });
        }

        return [
          runConfig.label,
          {
            overall: averageMetrics(queries),
            byIntent: buildGroupedMetrics(
              INTENTS,
              queries,
              (queryRun) => queryRun.intent,
            ),
            byFailureBucket: buildGroupedMetricsFromValues(
              uniqueValues(queries.map((queryRun) => queryRun.failureBucket)),
              queries,
              (queryRun) => queryRun.failureBucket,
            ),
            byRepoType: buildGroupedMetricsFromValues(
              uniqueValues([...repoTypeByRepo.values()]),
              queries,
              (queryRun) => {
                const firstRelevant = dataset.queries
                  .find((query) => query.id === queryRun.id)
                  ?.relevantFiles[0];
                if (!firstRelevant) return 'unknown';
                return repoTypeByRepo.get(firstRelevant.repository) ?? 'unknown';
              },
            ),
            diversity: averageDiversity(queries),
            diversityByIntent: buildGroupedDiversity(
              INTENTS,
              queries,
              (queryRun) => queryRun.intent,
            ),
            diversityByFailureBucket: buildGroupedDiversityFromValues(
              uniqueValues(queries.map((queryRun) => queryRun.failureBucket)),
              queries,
              (queryRun) => queryRun.failureBucket,
            ),
            queries,
          } satisfies SearchEvalModeSummary,
        ] as const;
      }),
    ),
  ) as Record<string, SearchEvalModeSummary>;

  const summary: SearchEvalSummary = {
    generatedAt: new Date().toISOString(),
    artifactPath: SEARCH_RELEVANCE_ARTIFACT_PATH,
    dataset: {
      dimensions: dataset.corpus.dimensions,
      dataSourceCount: dataset.corpus.dataSources.length,
      fileCount: new Set(dataset.corpus.chunks.map((chunk) => `${chunk.dataSourceId}:${chunk.filePath}`)).size,
      chunkCount: dataset.corpus.chunks.length,
      queryCount: dataset.queries.length,
      queryCountByIntent: Object.fromEntries(
        INTENTS.map((intent) => [
          intent,
          dataset.queries.filter((query) => query.intent === intent).length,
        ]),
      ) as Record<SearchEvalIntent, number>,
      repoCountByType: Object.fromEntries(
        uniqueValues(dataset.corpus.dataSources.map((source) => source.repoType)).map((repoType) => [
          repoType,
          dataset.corpus.dataSources.filter((source) => source.repoType === repoType).length,
        ]),
      ),
    },
    modes,
    weaknessReport: buildWeaknessReport(modes.hybrid, modes['hybrid-no-path'], dataset),
  };

  mkdirSync(dirname(SEARCH_RELEVANCE_ARTIFACT_PATH), { recursive: true });
  writeFileSync(SEARCH_RELEVANCE_ARTIFACT_PATH, JSON.stringify(summary, null, 2));

  return summary;
}

export function collapseResultsToFiles(
  results: RetrievalResult[],
  repoByDataSourceId: ReadonlyMap<string, string>,
): SearchEvalFileResult[] {
  const collapsed: SearchEvalFileResult[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const repository = repoByDataSourceId.get(result.chunk.dataSourceId);
    if (!repository) {
      throw new Error(`Missing repository mapping for data source ${result.chunk.dataSourceId}`);
    }

    const key = toFileKey(repository, result.chunk.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push({
      rank: collapsed.length + 1,
      repository,
      filePath: result.chunk.filePath,
      chunkId: result.chunk.id,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
      score: Number((-result.distance).toFixed(6)),
      diagnostics: result.diagnostics,
    });
  }

  return collapsed;
}

export function formatSearchEvalReport(summary: SearchEvalSummary): string {
  const lines: string[] = [];
  lines.push('Search relevance benchmark');
  lines.push(
    `dataset: ${summary.dataset.queryCount} queries, ${summary.dataset.fileCount} files, ` +
    `${summary.dataset.chunkCount} chunks, ${summary.dataset.dataSourceCount} repos`,
  );
  lines.push(`artifact: ${summary.artifactPath}`);
  lines.push('');
  lines.push('overall');
  lines.push(formatMetricTable(Object.keys(summary.modes), summary.modes, (modeSummary) => modeSummary.overall));

  for (const intent of INTENTS) {
    if (!summary.dataset.queryCountByIntent[intent]) continue;
    lines.push('');
    lines.push(`${intent} (${summary.dataset.queryCountByIntent[intent]} queries)`);
    lines.push(formatMetricTable(Object.keys(summary.modes), summary.modes, (modeSummary) => modeSummary.byIntent[intent]));
  }

  lines.push('');
  lines.push('weaknesses');
  for (const item of summary.weaknessReport.topFailedIntents) {
    lines.push(`- intent: ${item.intent} (R@1 gap ${item.recallAt1Gap.toFixed(3)})`);
  }
  for (const item of summary.weaknessReport.topPathPenaltyQueries) {
    lines.push(`- path penalty: ${item.queryId} (R@1 gap ${item.recallAt1Gap.toFixed(3)})`);
  }
  for (const item of summary.weaknessReport.topDuplicateCrowdingQueries) {
    lines.push(
      `- duplicate crowding: ${item.queryId} ` +
      `(raw dup@5 ${item.duplicateFileCrowdingCountTop5}, ` +
      `secondary@5 ${formatNullableBoolean(item.secondaryRelevantFileInTop5)})`,
    );
  }

  const duplicateCrowdingSummary = summary.modes.hybrid.diversityByFailureBucket['duplicate-crowding'];
  if (duplicateCrowdingSummary) {
    lines.push('');
    lines.push('diversity (hybrid payload)');
    lines.push(formatDiversityTable([
      ['overall', summary.modes.hybrid.diversity],
      ['duplicate-crowding', duplicateCrowdingSummary],
    ]));
  }

  return lines.join('\n');
}

function formatMetricTable(
  modeLabels: string[],
  summaries: Record<string, SearchEvalModeSummary>,
  pickMetrics: (summary: SearchEvalModeSummary) => SearchEvalMetrics,
): string {
  const rows = [
    ['mode', 'R@1', 'R@3', 'R@5', 'R@10', 'MRR@10', 'nDCG@10', 'S@5'],
    ...modeLabels.map((mode) => {
      const metrics = pickMetrics(summaries[mode]);
      return [
        mode,
        formatMetric(metrics.recallAt1),
        formatMetric(metrics.recallAt3),
        formatMetric(metrics.recallAt5),
        formatMetric(metrics.recallAt10),
        formatMetric(metrics.mrrAt10),
        formatMetric(metrics.ndcgAt10),
        formatMetric(metrics.successAt5),
      ];
    }),
  ];

  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length)),
  );

  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
    .join('\n');
}

function formatMetric(value: number): string {
  return value.toFixed(3);
}

function formatNullableBoolean(value: boolean | null): string {
  if (value === null) return 'n/a';
  return value ? 'yes' : 'no';
}

function formatDiversityTable(
  rows: Array<[label: string, metrics: SearchEvalDiversitySummary]>,
): string {
  const table = [
    ['scope', 'rawU@5', 'U@5', 'dup@5', 'dup@10', 'secondary@5', 'dupShare'],
    ...rows.map(([label, metrics]) => [
      label,
      formatMetric(metrics.rawUniqueFilesInTop5),
      formatMetric(metrics.uniqueFilesInTop5),
      formatMetric(metrics.duplicateFileCrowdingCountTop5),
      formatMetric(metrics.duplicateFileCrowdingCountTop10),
      formatMetric(metrics.secondaryRelevantFileInTop5),
      formatMetric(metrics.firstPageDuplicateShare),
    ]),
  ];

  const widths = table[0].map((_, columnIndex) =>
    Math.max(...table.map((row) => row[columnIndex].length)),
  );

  return table
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
    .join('\n');
}

function scoreFileRanking(
  query: SearchEvalQuery,
  results: SearchEvalFileResult[],
  topK: number,
): SearchEvalMetrics {
  const relevant = new Map(
    query.relevantFiles.map((file) => [toFileKey(file.repository, file.filePath), file.grade]),
  );
  const relevantCount = relevant.size || 1;
  const top = results.slice(0, topK);
  const recallAt = (limit: number) =>
    top
      .slice(0, limit)
      .filter((result) => relevant.has(toFileKey(result.repository, result.filePath)))
      .length / relevantCount;

  const firstRelevantRank =
    top.find((result) => relevant.has(toFileKey(result.repository, result.filePath)))?.rank ?? null;

  return {
    recallAt1: recallAt(1),
    recallAt3: recallAt(3),
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    mrrAt10: firstRelevantRank ? 1 / firstRelevantRank : 0,
    ndcgAt10: scoreNdcgAt(query, top, topK),
    successAt5:
      top
        .slice(0, 5)
        .some((result) => relevant.has(toFileKey(result.repository, result.filePath)))
        ? 1
        : 0,
  };
}

function scoreNdcgAt(
  query: SearchEvalQuery,
  results: SearchEvalFileResult[],
  topK: number,
): number {
  const grades = new Map(
    query.relevantFiles.map((file) => [toFileKey(file.repository, file.filePath), file.grade]),
  );

  const dcg = results.slice(0, topK).reduce((sum, result, index) => {
    const grade = grades.get(toFileKey(result.repository, result.filePath)) ?? 0;
    return sum + ((2 ** grade) - 1) / Math.log2(index + 2);
  }, 0);

  const idcg = [...grades.values()]
    .sort((a, b) => b - a)
    .slice(0, topK)
    .reduce((sum, grade, index) => sum + ((2 ** grade) - 1) / Math.log2(index + 2), 0);

  return idcg === 0 ? 0 : dcg / idcg;
}

function scoreChunkHitAt5(query: SearchEvalQuery, results: RetrievalResult[]): boolean | null {
  if (!query.relevantChunks?.length) return null;
  const relevant = new Set(query.relevantChunks.map((chunk) => chunk.chunkId));
  return results.slice(0, 5).some((result) => relevant.has(result.chunk.id));
}

function scoreFileDiversity(
  query: SearchEvalQuery,
  rawResults: RetrievalResult[],
  returnedResults: RetrievalResult[],
  repoByDataSourceId: ReadonlyMap<string, string>,
): SearchEvalDiversityDiagnostics {
  return {
    rawUniqueFilesInTop1: countUniqueResultFiles(rawResults, 1),
    rawUniqueFilesInTop3: countUniqueResultFiles(rawResults, 3),
    rawUniqueFilesInTop5: countUniqueResultFiles(rawResults, 5),
    uniqueFilesInTop1: countUniqueResultFiles(returnedResults, 1),
    uniqueFilesInTop3: countUniqueResultFiles(returnedResults, 3),
    uniqueFilesInTop5: countUniqueResultFiles(returnedResults, 5),
    duplicateFileCrowdingCountTop5: countDuplicateResultFiles(rawResults, 5),
    duplicateFileCrowdingCountTop10: countDuplicateResultFiles(rawResults, 10),
    rawSecondaryRelevantFileInTop5: hasSecondaryRelevantFileInTop(query, rawResults, 5, repoByDataSourceId),
    secondaryRelevantFileInTop5: hasSecondaryRelevantFileInTop(query, returnedResults, 5, repoByDataSourceId),
    rawFirstPageDuplicateShare: computeDuplicateShare(rawResults, 5),
    firstPageDuplicateShare: computeDuplicateShare(returnedResults, 5),
  };
}

function averageMetrics(queries: SearchEvalQueryRun[]): SearchEvalMetrics {
  const denominator = queries.length || 1;

  return {
    recallAt1: sumMetric(queries, (query) => query.metrics.recallAt1) / denominator,
    recallAt3: sumMetric(queries, (query) => query.metrics.recallAt3) / denominator,
    recallAt5: sumMetric(queries, (query) => query.metrics.recallAt5) / denominator,
    recallAt10: sumMetric(queries, (query) => query.metrics.recallAt10) / denominator,
    mrrAt10: sumMetric(queries, (query) => query.metrics.mrrAt10) / denominator,
    ndcgAt10: sumMetric(queries, (query) => query.metrics.ndcgAt10) / denominator,
    successAt5: sumMetric(queries, (query) => query.metrics.successAt5) / denominator,
  };
}

function averageDiversity(queries: SearchEvalQueryRun[]): SearchEvalDiversitySummary {
  const denominator = queries.length || 1;
  const secondaryDenominator =
    queries.filter((query) => query.diversity.secondaryRelevantFileInTop5 !== null).length || 1;
  const rawSecondaryDenominator =
    queries.filter((query) => query.diversity.rawSecondaryRelevantFileInTop5 !== null).length || 1;

  return {
    rawUniqueFilesInTop1: sumDiversity(queries, (query) => query.diversity.rawUniqueFilesInTop1) / denominator,
    rawUniqueFilesInTop3: sumDiversity(queries, (query) => query.diversity.rawUniqueFilesInTop3) / denominator,
    rawUniqueFilesInTop5: sumDiversity(queries, (query) => query.diversity.rawUniqueFilesInTop5) / denominator,
    uniqueFilesInTop1: sumDiversity(queries, (query) => query.diversity.uniqueFilesInTop1) / denominator,
    uniqueFilesInTop3: sumDiversity(queries, (query) => query.diversity.uniqueFilesInTop3) / denominator,
    uniqueFilesInTop5: sumDiversity(queries, (query) => query.diversity.uniqueFilesInTop5) / denominator,
    duplicateFileCrowdingCountTop5:
      sumDiversity(queries, (query) => query.diversity.duplicateFileCrowdingCountTop5) / denominator,
    duplicateFileCrowdingCountTop10:
      sumDiversity(queries, (query) => query.diversity.duplicateFileCrowdingCountTop10) / denominator,
    rawSecondaryRelevantFileInTop5:
      sumOptionalBooleanMetric(queries, (query) => query.diversity.rawSecondaryRelevantFileInTop5) /
      rawSecondaryDenominator,
    secondaryRelevantFileInTop5:
      sumOptionalBooleanMetric(queries, (query) => query.diversity.secondaryRelevantFileInTop5) /
      secondaryDenominator,
    rawFirstPageDuplicateShare:
      sumDiversity(queries, (query) => query.diversity.rawFirstPageDuplicateShare) / denominator,
    firstPageDuplicateShare:
      sumDiversity(queries, (query) => query.diversity.firstPageDuplicateShare) / denominator,
  };
}

function buildGroupedMetrics<T extends string>(
  values: readonly T[],
  queries: SearchEvalQueryRun[],
  pick: (query: SearchEvalQueryRun) => T,
): Record<T, SearchEvalMetrics> {
  return Object.fromEntries(
    values.map((value) => [
      value,
      averageMetrics(queries.filter((query) => pick(query) === value)),
    ]),
  ) as Record<T, SearchEvalMetrics>;
}

function buildGroupedMetricsFromValues<T extends string>(
  values: readonly T[],
  queries: SearchEvalQueryRun[],
  pick: (query: SearchEvalQueryRun) => T,
): Record<T, SearchEvalMetrics> {
  return buildGroupedMetrics(values, queries, pick);
}

function buildGroupedDiversity<T extends string>(
  values: readonly T[],
  queries: SearchEvalQueryRun[],
  pick: (query: SearchEvalQueryRun) => T,
): Record<T, SearchEvalDiversitySummary> {
  return Object.fromEntries(
    values.map((value) => [
      value,
      averageDiversity(queries.filter((query) => pick(query) === value)),
    ]),
  ) as Record<T, SearchEvalDiversitySummary>;
}

function buildGroupedDiversityFromValues<T extends string>(
  values: readonly T[],
  queries: SearchEvalQueryRun[],
  pick: (query: SearchEvalQueryRun) => T,
): Record<T, SearchEvalDiversitySummary> {
  return buildGroupedDiversity(values, queries, pick);
}

function sumMetric(
  queries: SearchEvalQueryRun[],
  pick: (query: SearchEvalQueryRun) => number,
): number {
  return queries.reduce((sum, query) => sum + pick(query), 0);
}

function sumDiversity(
  queries: SearchEvalQueryRun[],
  pick: (query: SearchEvalQueryRun) => number,
): number {
  return queries.reduce((sum, query) => sum + pick(query), 0);
}

function sumOptionalBooleanMetric(
  queries: SearchEvalQueryRun[],
  pick: (query: SearchEvalQueryRun) => boolean | null,
): number {
  return queries.reduce((sum, query) => sum + (pick(query) ? 1 : 0), 0);
}

function resolveQueryScope(
  repository: string | null,
  dataSourceIdByRepo: ReadonlyMap<string, string>,
): string[] {
  if (!repository) return [];
  const dataSourceId = dataSourceIdByRepo.get(repository);
  if (!dataSourceId) {
    throw new Error(`Unknown search-eval repository scope: ${repository}`);
  }
  return [dataSourceId];
}

function toFileKey(repository: string, filePath: string): string {
  return `${repository}:${filePath}`;
}

function hasSecondaryRelevantFileInTop(
  query: SearchEvalQuery,
  results: RetrievalResult[],
  limit: number,
  repoByDataSourceId: ReadonlyMap<string, string>,
): boolean | null {
  if (query.relevantFiles.length < 2) return null;

  const secondaryFiles = new Set(
    query.relevantFiles
      .slice(1)
      .map((file) => toFileKey(file.repository, file.filePath)),
  );

  return results.slice(0, limit).some((result) => {
    const repository = repoByDataSourceId.get(result.chunk.dataSourceId);
    if (!repository) return false;
    return secondaryFiles.has(toFileKey(repository, result.chunk.filePath));
  });
}

function buildWeaknessReport(
  hybrid: SearchEvalModeSummary,
  hybridNoPath: SearchEvalModeSummary | undefined,
  dataset: SearchEvalDataset,
): SearchEvalWeaknessReport {
  const topFailedIntents = Object.entries(hybrid.byIntent)
    .map(([intent, metrics]) => ({ intent, recallAt1Gap: 1 - metrics.recallAt1 }))
    .sort((a, b) => b.recallAt1Gap - a.recallAt1Gap)
    .slice(0, 3);

  const repositoryMisses = new Map<string, number>();
  for (const queryRun of hybrid.queries) {
    const primaryRelevant = dataset.queries.find((query) => query.id === queryRun.id)?.relevantFiles[0];
    if (!primaryRelevant) continue;
    if (queryRun.metrics.recallAt1 >= 1) continue;
    repositoryMisses.set(
      primaryRelevant.repository,
      (repositoryMisses.get(primaryRelevant.repository) ?? 0) + 1,
    );
  }

  const misleadingTypes = new Map<string, number>();
  for (const queryRun of hybrid.queries) {
    if (!queryRun.topResultType) continue;
    if (queryRun.metrics.recallAt1 >= 1) continue;
    misleadingTypes.set(
      queryRun.topResultType,
      (misleadingTypes.get(queryRun.topResultType) ?? 0) + 1,
    );
  }

  const topPathPenaltyQueries = hybridNoPath
    ? hybrid.queries
      .map((queryRun) => {
        const noPath = hybridNoPath.queries.find((candidate) => candidate.id === queryRun.id);
        return {
          queryId: queryRun.id,
          recallAt1Gap: (noPath?.metrics.recallAt1 ?? 0) - queryRun.metrics.recallAt1,
        };
      })
      .filter((item) => item.recallAt1Gap > 0)
      .sort((a, b) => b.recallAt1Gap - a.recallAt1Gap)
      .slice(0, 5)
    : [];

  const topDuplicateCrowdingQueries = [...hybrid.queries]
    .filter((queryRun) => queryRun.diversity.duplicateFileCrowdingCountTop5 > 0)
    .sort((a, b) =>
      b.diversity.duplicateFileCrowdingCountTop5 - a.diversity.duplicateFileCrowdingCountTop5 ||
      Number(a.diversity.secondaryRelevantFileInTop5) -
        Number(b.diversity.secondaryRelevantFileInTop5),
    )
    .slice(0, 5)
    .map((queryRun) => ({
      queryId: queryRun.id,
      duplicateFileCrowdingCountTop5: queryRun.diversity.duplicateFileCrowdingCountTop5,
      secondaryRelevantFileInTop5: queryRun.diversity.secondaryRelevantFileInTop5,
    }));

  return {
    topFailedIntents,
    topFailedRepositories: [...repositoryMisses.entries()]
      .map(([repository, misses]) => ({ repository, misses }))
      .sort((a, b) => b.misses - a.misses)
      .slice(0, 5),
    topMisleadingResultTypes: [...misleadingTypes.entries()]
      .map(([resultType, count]) => ({ resultType, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    topPathPenaltyQueries,
    topDuplicateCrowdingQueries,
  };
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}
