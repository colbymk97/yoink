import { EmbeddingProvider } from '../embedding/embeddingProvider';
import { ChunkStore, ChunkRecord } from '../storage/chunkStore';
import { EmbeddingStore } from '../storage/embeddingStore';

export interface RetrievalResult {
  chunk: ChunkRecord;
  distance: number;
}

const RRF_K = 60;
const OVER_FETCH = 3;
const PATH_WEIGHT = 0.15;

export class Retriever {
  constructor(
    private readonly chunkStore: ChunkStore,
    private readonly embeddingStore: EmbeddingStore,
  ) {}

  async search(
    query: string,
    dataSourceIds: string[],
    provider: EmbeddingProvider,
    topK: number,
  ): Promise<RetrievalResult[]> {
    const [queryEmbedding] = await provider.embed([query]);
    const fetchK = topK * OVER_FETCH;

    const vecResults =
      dataSourceIds.length > 0
        ? this.embeddingStore.search(queryEmbedding, dataSourceIds, fetchK)
        : this.embeddingStore.searchAll(queryEmbedding, fetchK);

    const ftsResults =
      dataSourceIds.length > 0
        ? this.chunkStore.searchFts(query, dataSourceIds, fetchK)
        : this.chunkStore.searchFtsAll(query, fetchK);

    const vecRank = new Map(vecResults.map((r, i) => [r.chunkId, i + 1]));
    const ftsRank = new Map(ftsResults.map((r, i) => [r.chunkId, i + 1]));

    const candidateIds = new Set([
      ...vecResults.map((r) => r.chunkId),
      ...ftsResults.map((r) => r.chunkId),
    ]);

    const penalty = fetchK + 1;
    const queryTokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    const results: RetrievalResult[] = [];
    for (const id of candidateIds) {
      const chunk = this.chunkStore.getById(id);
      if (!chunk) continue;

      const vRank = vecRank.get(id) ?? penalty;
      const fRank = ftsRank.get(id) ?? penalty;
      const rrfScore = 1 / (RRF_K + vRank) + 1 / (RRF_K + fRank);
      const pathScore = pathRelevance(chunk.filePath, queryTokens);

      // Negate so lower distance = better (preserves existing caller contract)
      results.push({ chunk, distance: -(rrfScore + PATH_WEIGHT * pathScore) });
    }

    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, topK);
  }
}

function pathRelevance(filePath: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const lower = filePath.toLowerCase();
  const matches = queryTokens.filter((t) => lower.includes(t)).length;
  return matches / queryTokens.length;
}
