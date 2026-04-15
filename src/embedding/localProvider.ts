import { EmbeddingProvider, estimateTokens } from './embeddingProvider';

export interface LocalProviderOptions {
  baseUrl: string;   // e.g. http://localhost:11434/v1
  model: string;     // e.g. nomic-embed-text
  dimensions: number;
  apiKey?: string;   // optional — some local servers require a key
}

/** Transient HTTP status codes that warrant a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local';
  readonly maxBatchSize = 512;  // conservative for local hardware
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(options: LocalProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.apiKey = options.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);
    }
    return results;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({ model: this.model, input: texts });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await this.fetchWithRetry(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Local embedding API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, init);

        if (!RETRYABLE_STATUS_CODES.has(res.status) || attempt === MAX_RETRIES) {
          return res;
        }

        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);

        await sleep(waitMs);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === MAX_RETRIES) break;
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      }
    }

    throw lastError ?? new Error('Request failed after retries');
  }

  countTokens(text: string): number {
    // Local models are arbitrary — tiktoken doesn't know them, so always estimate
    return estimateTokens(text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
