import { EmbeddingProvider, estimateTokens } from './embeddingProvider';
import { encodingForModel } from './tiktokenLoader';
import type { Tiktoken } from 'tiktoken';

export interface AzureOpenAIProviderOptions {
  apiKey: string;
  endpoint: string;       // e.g. https://myresource.openai.azure.com
  deploymentName: string;
  apiVersion: string;     // e.g. 2024-02-01
  dimensions: number;
}

/** Transient HTTP status codes that warrant a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/** Azure OpenAI enforces the same 300k-token-per-request cap; leave headroom. */
const MAX_TOKENS_PER_REQUEST = 270_000;

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'azure-openai';
  readonly maxBatchSize = 2048;
  /** Azure OpenAI matches OpenAI's 8192-token per-input cap; leave headroom. */
  readonly maxInputTokens = 8000;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly embedUrl: string;
  private tokenizer: Tiktoken | null = null;

  constructor(options: AzureOpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.dimensions = options.dimensions;
    const base = options.endpoint.replace(/\/$/, '');
    this.embedUrl = `${base}/openai/deployments/${options.deploymentName}/embeddings?api-version=${options.apiVersion}`;
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
    const body = JSON.stringify({ input: texts });

    const res = await this.fetchWithRetry(this.embedUrl, {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Azure OpenAI API error ${res.status}: ${text}`);
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
      // cl100k_base covers all current Azure OpenAI embedding models
      this.tokenizer = encodingForModel('text-embedding-3-small');
    }
    return this.tokenizer;
  }

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
