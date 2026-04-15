import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AzureOpenAIEmbeddingProvider } from '../../../src/embedding/azureOpenAIProvider';

function makeProvider(
  overrides: Partial<{
    apiKey: string;
    endpoint: string;
    deploymentName: string;
    apiVersion: string;
    dimensions: number;
  }> = {},
) {
  return new AzureOpenAIEmbeddingProvider({
    apiKey: 'test-azure-key',
    endpoint: 'https://myresource.openai.azure.com',
    deploymentName: 'my-embedding-deployment',
    apiVersion: '2024-02-01',
    dimensions: 1536,
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

describe('AzureOpenAIEmbeddingProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('sets dimensions from options', () => {
      expect(makeProvider({ dimensions: 1536 }).dimensions).toBe(1536);
      expect(makeProvider({ dimensions: 3072 }).dimensions).toBe(3072);
    });

    it('builds correct embed URL', () => {
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));
      const provider = makeProvider({
        endpoint: 'https://myresource.openai.azure.com',
        deploymentName: 'my-embed',
        apiVersion: '2024-02-01',
      });

      provider.embed(['test']).catch(() => {}); // fire request

      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
        'https://myresource.openai.azure.com/openai/deployments/my-embed/embeddings?api-version=2024-02-01',
      );
    });

    it('strips trailing slash from endpoint', async () => {
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));
      const provider = makeProvider({ endpoint: 'https://myresource.openai.azure.com/' });

      await provider.embed(['test']);

      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).not.toContain('//openai');
    });
  });

  describe('embed', () => {
    it('returns empty array for empty input', async () => {
      const provider = makeProvider();
      expect(await provider.embed([])).toEqual([]);
    });

    it('uses api-key header (not Authorization Bearer)', async () => {
      const embeddings = [[0.1, 0.2]];
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse(embeddings));

      await makeProvider({ apiKey: 'my-azure-key' }).embed(['hello']);

      const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['api-key']).toBe('my-azure-key');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('does not send model field in request body', async () => {
      const embeddings = [[0.1, 0.2]];
      globalThis.fetch = mockFetchResponse(makeEmbeddingResponse(embeddings));

      await makeProvider().embed(['hello']);

      const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.model).toBeUndefined();
      expect(body.input).toEqual(['hello']);
    });

    it('returns ordered embeddings', async () => {
      const embeddings = [[0.3, 0.4], [0.1, 0.2]];
      // Return out of order to test sorting
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

    it('throws on non-retryable error', async () => {
      globalThis.fetch = mockFetchResponse({ error: 'Unauthorized' }, 401);

      await expect(makeProvider().embed(['test'])).rejects.toThrow('Azure OpenAI API error 401');
    });

    it('retries on 429 and eventually throws', async () => {
      globalThis.fetch = mockFetchResponse({ error: 'Rate limited' }, 429);
      vi.useFakeTimers();

      // Attach rejection handler before advancing timers to avoid unhandled rejection
      const rejectionPromise = expect(makeProvider().embed(['test'])).rejects.toThrow('Azure OpenAI API error 429');
      await vi.runAllTimersAsync();
      await rejectionPromise;

      vi.useRealTimers();
    }, 10000);
  });

  describe('countTokens', () => {
    it('returns a positive number for non-empty text', () => {
      const count = makeProvider().countTokens('hello world');
      expect(count).toBeGreaterThan(0);
    });

    it('returns 0 for empty string', () => {
      expect(makeProvider().countTokens('')).toBe(0);
    });
  });

  describe('dispose', () => {
    it('can be called without error', () => {
      const provider = makeProvider();
      expect(() => provider.dispose()).not.toThrow();
    });

    it('can be called multiple times safely', () => {
      const provider = makeProvider();
      provider.dispose();
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});
