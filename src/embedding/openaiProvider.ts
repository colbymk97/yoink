import { EmbeddingProvider } from './embeddingProvider';

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly maxBatchSize = 2048;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');

    // text-embedding-3-small = 1536, text-embedding-3-large = 3072
    this.dimensions = options.model.includes('3-large') ? 3072 : 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain input order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  countTokens(text: string): number {
    // TODO: integrate tiktoken for accurate counting
    // Approximation for now: ~4 chars per token for English code
    return Math.ceil(text.length / 4);
  }
}
