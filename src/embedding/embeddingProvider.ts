export interface EmbeddingProvider {
  readonly id: string;
  readonly maxBatchSize: number;
  readonly dimensions: number;

  embed(texts: string[]): Promise<number[][]>;

  countTokens?(text: string): number;
}
