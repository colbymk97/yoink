import { EmbeddingProvider, estimateTokens } from './embeddingProvider';
import { encodingForModel } from './tiktokenLoader';
import type { Tiktoken } from 'tiktoken';

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Transient HTTP status codes that warrant a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/** Known model → dimension mappings. */
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/** OpenAI hard limit is 300k tokens per /embeddings request; leave headroom. */
const MAX_TOKENS_PER_REQUEST = 270_000;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly maxBatchSize = 2048;
  /** OpenAI embedding models cap each input at 8192 tokens; leave headroom. */
  readonly maxInputTokens = 8000;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private tokenizer: Tiktoken | null = null;

  constructor(options: OpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.dimensions = MODEL_DIMENSIONS[options.model] ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    let batch: string[] = [];
    let batchTokens = 0;

    for (const text of texts) {
      const tokens = Math.min(this.countTokens(text), MAX_TOKENS_PER_REQUEST);

      const overCount = batch.length >= this.maxBatchSize;
      const overTokens = batch.length > 0 && batchTokens + tokens > MAX_TOKENS_PER_REQUEST;
      if (overCount || overTokens) {
        const batchResults = await this.embedBatch(batch);
        results.push(...batchResults);
        batch = [];
        batchTokens = 0;
      }

      batch.push(text);
      batchTokens += tokens;
    }

    if (batch.length > 0) {
      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({
      model: this.model,
      input: texts,
    });

    const res = await this.fetchWithRetry(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to guarantee input order
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

        // Use Retry-After header if present, otherwise exponential backoff
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
    try {
      const enc = this.getTokenizer();
      const tokens = enc.encode_ordinary(text);
      return tokens.length;
    } catch {
      return estimateTokens(text);
    }
  }

  private getTokenizer(): Tiktoken {
    if (!this.tokenizer) {
      try {
        this.tokenizer = encodingForModel(this.model);
      } catch {
        // Model not recognized by tiktoken — use cl100k_base (covers embedding models)
        this.tokenizer = encodingForModel('text-embedding-3-small');
      }
    }
    return this.tokenizer;
  }

  /**
   * Free the WASM tokenizer resources. Call when the provider is no longer needed.
   */
  dispose(): void {
    if (this.tokenizer) {
      this.tokenizer.free();
      this.tokenizer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
