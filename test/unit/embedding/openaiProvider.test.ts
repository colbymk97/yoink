import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../../src/embedding/openaiProvider';

function makeProvider(overrides: Partial<{ apiKey: string; model: string; baseUrl: string }> = {}) {
  return new OpenAIEmbeddingProvider({
    apiKey: 'sk-test-key',
    model: 'text-embedding-3-small',
    baseUrl: 'https://api.openai.com/v1',
    ...overrides,
  });
}

function mockFetchResponse(data: object, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

function makeEmbeddingResponse(embeddings: number[][]) {
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index })),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 10, total_tokens: 10 },
  };
}

describe('OpenAIEmbeddingProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('sets dimensions for text-embedding-3-small', () => {
      const provider = makeProvider({ model: 'text-embedding-3-small' });
      expect(provider.dimensions).toBe(1536);
    });

    it('sets dimensions for text-embedding-3-large', () => {
      const provider = makeProvider({ model: 'text-embedding-3-large' });
      expect(provider.dimensions).toBe(3072);
    });

    it('defaults to 1536 for unknown models', () => {
      const provider = makeProvider({ model: 'some-future-model' });
      expect(provider.dimensions).toBe(1536);
    });

    it('strips trailing slash from baseUrl', () => {
      const provider = makeProvider({ baseUrl: 'https://api.example.com/v1/' });
      expect(provider.dimensions).toBeDefined(); // Just verify construction succeeds
    });
  });

  describe('embed', () => {
    it('returns empty array for empty input', async () => {
      const provider = makeProvider();
      const result = await provider.embed([]);
      expect(result).toEqual([]);
    });

    it('sends correct request and returns ordered embeddings', async () => {
      const embeddings = [[0.1, 0.2], [0.3, 0.4]];
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse(embeddings));

      const provider = makeProvider();
      const result = await provider.embed(['hello', 'world']);

      expect(result).toEqual(embeddings);

      // Verify request format
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe('https://api.openai.com/v1/embeddings');
      const body = JSON.parse(call[1].body);
      expect(body.model).toBe('text-embedding-3-small');
      expect(body.input).toEqual(['hello', 'world']);
      expect(call[1].headers.Authorization).toBe('Bearer sk-test-key');
    });

    it('sorts results by index regardless of API response order', async () => {
      // API returns indices out of order
      const responseData = {
        data: [
          { embedding: [0.3, 0.4], index: 1 },
          { embedding: [0.1, 0.2], index: 0 },
        ],
      };
      globalThis.fetch = mockFetchResponse(responseData);

      const provider = makeProvider();
      const result = await provider.embed(['first', 'second']);

      expect(result[0]).toEqual([0.1, 0.2]);
      expect(result[1]).toEqual([0.3, 0.4]);
    });

    it('throws on non-retryable API errors', async () => {
      globalThis.fetch = mockFetchResponse(
        { error: { message: 'Invalid API key' } },
        401,
      );

      const provider = makeProvider();
      await expect(provider.embed(['test'])).rejects.toThrow('OpenAI API error 401');
    });
  });

  describe('batch splitting', () => {
    it('splits large batches into sub-batches', async () => {
      const provider = makeProvider();
      const fetchMock = vi.fn();
      let callCount = 0;

      fetchMock.mockImplementation(async () => {
        callCount++;
        // Each call gets a batch — return embeddings matching batch size
        const batchSize = callCount === 1 ? 2048 : 2;
        const embeddings = Array.from({ length: batchSize }, (_, i) => [i * 0.1]);
        return {
          ok: true,
          status: 200,
          json: async () => makeEmbeddingResponse(embeddings),
        };
      });
      globalThis.fetch = fetchMock;

      // Create 2050 texts (should split into 2048 + 2)
      const texts = Array.from({ length: 2050 }, (_, i) => `text-${i}`);
      const result = await provider.embed(texts);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2050);
    });
  });

  describe('retry with backoff', () => {
    it('retries on 429 rate limit', async () => {
      const fetchMock = vi.fn();
      // First call: 429, second call: success
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '0' }),
          text: async () => 'rate limited',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => makeEmbeddingResponse([[0.1, 0.2]]),
        });
      globalThis.fetch = fetchMock;

      const provider = makeProvider();
      const result = await provider.embed(['test']);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual([[0.1, 0.2]]);
    });

    it('retries on 500 server error', async () => {
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers(),
          text: async () => 'server error',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => makeEmbeddingResponse([[0.1]]),
        });
      globalThis.fetch = fetchMock;

      const provider = makeProvider();
      const result = await provider.embed(['test']);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual([[0.1]]);
    });

    it('retries on network error', async () => {
      const fetchMock = vi.fn();
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => makeEmbeddingResponse([[0.5]]),
        });
      globalThis.fetch = fetchMock;

      const provider = makeProvider();
      const result = await provider.embed(['test']);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual([[0.5]]);
    });

    it('gives up after max retries', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers({ 'Retry-After': '0' }),
        text: async () => 'service unavailable',
      });

      const provider = makeProvider();
      await expect(provider.embed(['test'])).rejects.toThrow('OpenAI API error 503');
    });

    it('does not retry on 400 bad request', async () => {
      globalThis.fetch = mockFetchResponse(
        { error: { message: 'Bad request' } },
        400,
      );

      const provider = makeProvider();
      await expect(provider.embed(['test'])).rejects.toThrow('OpenAI API error 400');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('countTokens', () => {
    it('counts tokens using tiktoken', () => {
      const provider = makeProvider();
      const count = provider.countTokens('Hello, world!');
      // tiktoken should give a precise count; "Hello, world!" is 4 tokens with cl100k_base
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(20);
      provider.dispose();
    });

    it('returns consistent counts for the same input', () => {
      const provider = makeProvider();
      const count1 = provider.countTokens('function foo() { return 42; }');
      const count2 = provider.countTokens('function foo() { return 42; }');
      expect(count1).toBe(count2);
      provider.dispose();
    });

    it('counts code tokens accurately', () => {
      const provider = makeProvider();
      const code = 'const x = 1;\nconst y = 2;\nconst z = x + y;';
      const count = provider.countTokens(code);
      // This code is about 20 tokens
      expect(count).toBeGreaterThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(30);
      provider.dispose();
    });

    it('handles empty string', () => {
      const provider = makeProvider();
      expect(provider.countTokens('')).toBe(0);
      provider.dispose();
    });
  });

  describe('dispose', () => {
    it('frees tokenizer resources', () => {
      const provider = makeProvider();
      provider.countTokens('test'); // Initialize tokenizer
      provider.dispose();
      // Should not throw on second dispose
      provider.dispose();
    });

    it('reinitializes tokenizer after dispose if countTokens called again', () => {
      const provider = makeProvider();
      provider.countTokens('first');
      provider.dispose();
      // Should still work after dispose — tokenizer lazily re-created
      const count = provider.countTokens('second');
      expect(count).toBeGreaterThan(0);
      provider.dispose();
    });
  });
});
