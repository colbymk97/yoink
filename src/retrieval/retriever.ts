import { EmbeddingProvider } from '../embedding/embeddingProvider';
import { ChunkStore, ChunkRecord } from '../storage/chunkStore';
import { EmbeddingStore } from '../storage/embeddingStore';

export interface RetrievalResult {
  chunk: ChunkRecord;
  distance: number;
}

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

    const searchResults =
      dataSourceIds.length > 0
        ? this.embeddingStore.search(queryEmbedding, dataSourceIds, topK)
        : this.embeddingStore.searchAll(queryEmbedding, topK);

    const results: RetrievalResult[] = [];
    for (const result of searchResults) {
      const chunk = this.chunkStore.getById(result.chunkId);
      if (chunk) {
        results.push({ chunk, distance: result.distance });
      }
    }

    return results;
  }
}
