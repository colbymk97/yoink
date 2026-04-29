import { describe, expect, it } from 'vitest';
import { RetrievalResult } from '../../../src/retrieval/retriever';
import {
  buildSearchPayload,
  computeDuplicateShare,
  countDuplicateResultFiles,
  countUniqueResultFiles,
  rerankSearchResultsByFile,
  sortSearchResultsStable,
} from '../../../src/tools/searchPayload';

function makeResult(
  id: string,
  filePath: string,
  distance: number,
  startLine = 1,
  dataSourceId = 'ds-1',
): RetrievalResult {
  return {
    chunk: {
      id,
      dataSourceId,
      filePath,
      startLine,
      endLine: startLine + 2,
      content: `chunk ${id}`,
      tokenCount: 10,
    },
    distance,
  };
}

describe('searchPayload', () => {
  it('shows that raw chunk-ranked results can crowd page 1 with duplicate files', () => {
    const results = [
      makeResult('a-1', 'src/auth/sessionManager.ts', -0.1, 1),
      makeResult('a-2', 'src/auth/sessionManager.ts', -0.11, 25),
      makeResult('b-1', 'src/security/tokenVerifier.ts', -0.12, 1),
      makeResult('c-1', 'docs/authentication-guide.md', -0.13, 1),
    ];

    const ranked = sortSearchResultsStable(results);

    expect(ranked.slice(0, 3).map((result) => result.chunk.filePath)).toEqual([
      'src/auth/sessionManager.ts',
      'src/auth/sessionManager.ts',
      'src/security/tokenVerifier.ts',
    ]);
  });

  it('measures duplicate crowding and unique-file coverage in the raw ranking', () => {
    const results = [
      makeResult('a-1', 'src/auth/sessionManager.ts', -0.1, 1),
      makeResult('a-2', 'src/auth/sessionManager.ts', -0.11, 25),
      makeResult('b-1', 'src/security/tokenVerifier.ts', -0.12, 1),
      makeResult('c-1', 'docs/authentication-guide.md', -0.13, 1),
      makeResult('a-3', 'src/auth/sessionManager.ts', -0.14, 50),
    ];

    expect(countUniqueResultFiles(results, 5)).toBe(3);
    expect(countDuplicateResultFiles(results, 5)).toBe(2);
    expect(computeDuplicateShare(results, 5)).toBeCloseTo(0.4);
  });

  it('reranks the best chunk per file ahead of deferred duplicates', () => {
    const results = [
      makeResult('a-1', 'src/auth/sessionManager.ts', -0.1, 1),
      makeResult('a-2', 'src/auth/sessionManager.ts', -0.11, 25),
      makeResult('b-1', 'src/security/tokenVerifier.ts', -0.12, 1),
      makeResult('c-1', 'docs/authentication-guide.md', -0.13, 1),
      makeResult('a-3', 'src/auth/sessionManager.ts', -0.14, 50),
    ];

    expect(rerankSearchResultsByFile(results).map((result) => result.chunk.id)).toEqual([
      'a-1',
      'b-1',
      'c-1',
      'a-2',
      'a-3',
    ]);
  });

  it('applies pagination after file-diversity reranking', () => {
    const results = [
      makeResult('a-1', 'src/auth/sessionManager.ts', -0.1, 1),
      makeResult('a-2', 'src/auth/sessionManager.ts', -0.11, 25),
      makeResult('b-1', 'src/security/tokenVerifier.ts', -0.12, 1),
      makeResult('c-1', 'docs/authentication-guide.md', -0.13, 1),
      makeResult('a-3', 'src/auth/sessionManager.ts', -0.14, 50),
    ];

    const firstPage = buildSearchPayload(
      results,
      () => 'acme/yoink-app',
      { pageSize: 3, offset: 0, nextCursor: 'cursor-1' },
    );

    expect(firstPage.results.map((result) => result.id)).toEqual(['a-1', 'b-1', 'c-1']);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe('cursor-1');

    const secondPage = buildSearchPayload(
      results,
      () => 'acme/yoink-app',
      { pageSize: 3, offset: 3 },
    );

    expect(secondPage.results.map((result) => result.id)).toEqual(['a-2', 'a-3']);
    expect(secondPage.hasMore).toBe(false);
  });
});
