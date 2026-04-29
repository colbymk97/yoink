import { ChunkRecord } from '../storage/chunkStore';
import { RetrievalResult } from '../retrieval/retriever';

const DEFAULT_SEARCH_PAGE_SIZE = 5;
const MAX_SEARCH_PAGE_SIZE = 25;
const SEARCH_SNIPPET_MAX_CHARS = 320;

export type SearchResultType = 'code' | 'documentation' | 'workflow' | 'action' | 'config';

export interface SearchPayloadResult {
  id: string;
  repository: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  resultType: SearchResultType;
}

export interface SearchPayload {
  searchedRepositories: string;
  pageSize: number;
  resultCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  results: SearchPayloadResult[];
}

export interface SearchPayloadBuilderOptions {
  searchedRepositories?: string;
  pageSize?: number;
  offset?: number;
  nextCursor?: string | null;
}

export function buildSearchPayload(
  results: RetrievalResult[],
  resolveRepository: (chunk: ChunkRecord) => string | undefined,
  options: SearchPayloadBuilderOptions = {},
): SearchPayload {
  const resolvedPageSize = normalizeSearchPageSize(options.pageSize);
  const offset = options.offset ?? 0;
  const rerankedResults = rerankSearchResultsByFile(results);
  const page = rerankedResults.slice(offset, offset + resolvedPageSize + 1);
  const pageResults = page.slice(0, resolvedPageSize);
  const hasMore = page.length > resolvedPageSize;

  return {
    searchedRepositories: options.searchedRepositories ?? '',
    pageSize: resolvedPageSize,
    resultCount: pageResults.length,
    hasMore,
    nextCursor: hasMore ? options.nextCursor ?? null : null,
    results: pageResults.map((result) => ({
      id: result.chunk.id,
      repository: resolveRepository(result.chunk) ?? 'unknown',
      filePath: result.chunk.filePath,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
      score: Number((-result.distance).toFixed(6)),
      snippet: toSearchSnippet(result.chunk.content),
      resultType: classifySearchResultType(result.chunk.filePath),
    })),
  };
}

export function normalizeSearchPageSize(pageSize?: number): number {
  if (!Number.isFinite(pageSize)) return DEFAULT_SEARCH_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_SEARCH_PAGE_SIZE, Math.floor(pageSize as number)));
}

export function toSearchSnippet(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, SEARCH_SNIPPET_MAX_CHARS);
}

export function classifySearchResultType(filePath: string): SearchResultType {
  if (filePath.includes('.github/workflows/')) return 'workflow';
  if (filePath.endsWith('action.yml') || filePath.endsWith('action.yaml')) return 'action';
  if (/\.(md|mdx)$/i.test(filePath)) return 'documentation';
  if (/(^|\/)(package\.json|tsconfig\.json|eslint\.config|\.eslintrc|\.prettierrc)/i.test(filePath)) {
    return 'config';
  }
  return 'code';
}

export function sortSearchResultsStable(
  results: RetrievalResult[],
): RetrievalResult[] {
  return [...results].sort((a, b) => {
    const scoreDiff = b.distance - a.distance;
    if (scoreDiff !== 0) return scoreDiff;
    return (
      a.chunk.filePath.localeCompare(b.chunk.filePath) ||
      a.chunk.startLine - b.chunk.startLine ||
      a.chunk.endLine - b.chunk.endLine ||
      a.chunk.id.localeCompare(b.chunk.id)
    );
  });
}

export function rerankSearchResultsByFile(
  results: RetrievalResult[],
): RetrievalResult[] {
  const stableResults = sortSearchResultsStable(results);
  const uniqueFileResults: RetrievalResult[] = [];
  const deferredDuplicates: RetrievalResult[] = [];
  const seenFiles = new Set<string>();

  for (const result of stableResults) {
    const fileKey = getResultFileKey(result);
    if (seenFiles.has(fileKey)) {
      deferredDuplicates.push(result);
      continue;
    }

    seenFiles.add(fileKey);
    uniqueFileResults.push(result);
  }

  return [...uniqueFileResults, ...deferredDuplicates];
}

export function countUniqueResultFiles(
  results: RetrievalResult[],
  limit: number,
): number {
  return collectResultFileCounts(results, limit).uniqueFiles;
}

export function countDuplicateResultFiles(
  results: RetrievalResult[],
  limit: number,
): number {
  return collectResultFileCounts(results, limit).duplicates;
}

export function computeDuplicateShare(
  results: RetrievalResult[],
  limit: number,
): number {
  const consideredResults = Math.min(limit, results.length);
  if (consideredResults === 0) return 0;
  return countDuplicateResultFiles(results, limit) / consideredResults;
}

function collectResultFileCounts(
  results: RetrievalResult[],
  limit: number,
): { uniqueFiles: number; duplicates: number } {
  const seenFiles = new Set<string>();
  let duplicates = 0;

  for (const result of results.slice(0, limit)) {
    const fileKey = getResultFileKey(result);
    if (seenFiles.has(fileKey)) {
      duplicates++;
      continue;
    }
    seenFiles.add(fileKey);
  }

  return {
    uniqueFiles: seenFiles.size,
    duplicates,
  };
}

function getResultFileKey(result: RetrievalResult): string {
  return `${result.chunk.dataSourceId}:${result.chunk.filePath}`;
}
