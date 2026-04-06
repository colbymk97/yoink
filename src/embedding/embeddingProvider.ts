export interface EmbeddingProvider {
  readonly id: string;
  readonly maxBatchSize: number;
  readonly dimensions: number;

  /**
   * Embed an array of texts, returning one vector per input text.
   * Results are in the same order as the input array.
   */
  embed(texts: string[]): Promise<number[][]>;

  /**
   * Count the number of tokens in a text string.
   * Used for chunk sizing. Falls back to a character-based estimate
   * if not implemented by a provider.
   */
  countTokens(text: string): number;
}

/**
 * Fallback token counter: ~4 chars per token for English/code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
