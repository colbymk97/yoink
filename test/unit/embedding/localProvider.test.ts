import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalEmbeddingProvider } from '../../../src/embedding/localProvider';

function makeProvider(
  overrides: Partial<{
    baseUrl: string;
    model: string;
    dimensions: number;
    apiKey: string;
  }> = {},
) {
  return new LocalEmbeddingProvider({
    baseUrl: 'http://localhost:11434/v1',
    model: 'nomic-embed-text',
    dimensions: 768,
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
    usage: { prompt_tokens: 10, total_tokens: 10 },
  };
}

describe('LocalEmbeddingProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('sets dimensions from options', () => {
      expect(makeProvider({ dimensions: 768 }).dimensions).toBe(768);
      expect(makeProvider({ dimensions: 384 }).dimensions).toBe(384);
    });

    it('has conservative maxBatchSize of 512', () => {
      expect(makeProvider().maxBatchSize).toBe(512);
    });

    it('has id of "local"', () => {
      expect(makeProvider().id).toBe('local');
    });

    it('strips trailing slash from baseUrl', async () => {
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));
      await makeProvider({ baseUrl: 'http://localhost:11434/v1/' }).embed(['test']);

      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toBe('http://localhost:11434/v1/embeddings');
    });
  });

  describe('embed', () => {
    it('returns empty array for empty input', async () => {
      expect(await makeProvider().embed([])).toEqual([]);
    });

    it('sends model name and input in request body', async () => {
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1, 0.2]]));

      await makeProvider({ model: 'nomic-embed-text' }).embed(['hello']);

      const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('nomic-embed-text');
      expect(body.input).toEqual(['hello']);
    });

    it('does not send Authorization header when no apiKey', async () => {
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));

      await makeProvider().embed(['hello']);

      const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('sends Authorization Bearer header when apiKey is provided', async () => {
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));

      await makeProvider({ apiKey: 'my-local-key' }).embed(['hello']);

      const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer my-local-key');
    });

    it('returns ordered embeddings', async () => {
      const response = {
        data: [
          { embedding: [0.3, 0.4], index: 1 },
          { embedding: [0.1, 0.2], index: 0 },
        ],
      };
      globalThis.fetch = mockFetchResponse(response);

      const result = await makeProvider().embed(['first', 'second']);

      expect(result[0]).toEqual([0.1, 0.2]);
      expect(result[1]).toEqual([0.3, 0.4]);
    });

    it('throws on API error', async () => {
      globalThis.fetch = mockFetchResponse({ error: 'model not found' }, 404);

      await expect(makeProvider().embed(['test'])).rejects.toThrow('Local embedding API error 404');
    });

    it('retries on 429 and eventually throws', async () => {
      globalThis.fetch = mockFetchResponse({ error: 'Rate limited' }, 429);
      vi.useFakeTimers();

      // Attach rejection handler before advancing timers to avoid unhandled rejection
      const rejectionPromise = expect(makeProvider().embed(['test'])).rejects.toThrow('Local embedding API error 429');
      await vi.runAllTimersAsync();
      await rejectionPromise;

      vi.useRealTimers();
    }, 10000);

    it('splits large batches at maxBatchSize', async () => {
      const singleEmbedding = [0.1, 0.2];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: [{ embedding: singleEmbedding, index: 0 }],
        }),
        text: async () => '',
      });

      // 513 texts should trigger two fetch calls (512 + 1)
      const texts = Array.from({ length: 513 }, (_, i) => `text ${i}`);
      await makeProvider().embed(texts);

      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });
  });

  describe('countTokens', () => {
    it('always uses character-based estimation', () => {
      const provider = makeProvider();
      // estimateTokens uses Math.ceil(text.length / 4)
      expect(provider.countTokens('hello')).toBe(Math.ceil('hello'.length / 4));
      expect(provider.countTokens('hello world')).toBe(Math.ceil('hello world'.length / 4));
    });

    it('returns 0 for empty string', () => {
      expect(makeProvider().countTokens('')).toBe(0);
    });
  });
});
