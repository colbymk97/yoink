import { afterEach, describe, expect, it, vi } from 'vitest';

describe('tiktoken lazy loading', () => {
  afterEach(() => {
    vi.doUnmock('tiktoken');
    vi.resetModules();
  });

  it('loads the OpenAI provider module without initializing tiktoken', async () => {
    vi.doMock('tiktoken', () => {
      throw new Error('Missing tiktoken_bg.wasm');
    });

    const mod = await import('../../../src/embedding/openaiProvider');

    expect(mod.OpenAIEmbeddingProvider).toBeDefined();
  });

  it('falls back to estimated token counts when OpenAI tokenizer init fails', async () => {
    const { OpenAIEmbeddingProvider } = await import('../../../src/embedding/openaiProvider');
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      baseUrl: 'https://api.openai.com/v1',
    });

    vi.spyOn(provider as never, 'getTokenizer').mockImplementation(() => {
      throw new Error('Missing tiktoken_bg.wasm');
    });

    expect(provider.countTokens('1234')).toBe(1);
  });

  it('falls back to estimated token counts when Azure tokenizer init fails', async () => {
    const { AzureOpenAIEmbeddingProvider } = await import('../../../src/embedding/azureOpenAIProvider');
    const provider = new AzureOpenAIEmbeddingProvider({
      apiKey: 'test-azure-key',
      endpoint: 'https://myresource.openai.azure.com',
      deploymentName: 'my-embedding-deployment',
      apiVersion: '2024-02-01',
      dimensions: 1536,
    });

    vi.spyOn(provider as never, 'getTokenizer').mockImplementation(() => {
      throw new Error('Missing tiktoken_bg.wasm');
    });

    expect(provider.countTokens('1234')).toBe(1);
  });
});
