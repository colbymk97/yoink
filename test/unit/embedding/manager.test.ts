import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configListeners,
  configuration,
  showQuickPick,
  showInputBox,
  showInformationMessage,
  showWarningMessage,
  showErrorMessage,
  getEmbeddingConfigFingerprint,
  getEmbeddingDimensions,
  resetEmbeddingsTable,
  setEmbeddingConfigFingerprint,
  getConfigValues,
  setConfigValues,
} = vi.hoisted(() => {
  let configValues = new Map<string, string | number>();
  const configuration = {
    get: vi.fn((key: string, defaultValue?: string | number) => (
      configValues.has(key) ? configValues.get(key) : defaultValue
    )),
    update: vi.fn(async (key: string, value: string | number) => {
      configValues.set(key, value);
    }),
  };

  return {
    configListeners: [] as Array<(event: { affectsConfiguration: (key: string) => boolean }) => void>,
    configuration,
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    getEmbeddingConfigFingerprint: vi.fn(),
    getEmbeddingDimensions: vi.fn(),
    resetEmbeddingsTable: vi.fn(),
    setEmbeddingConfigFingerprint: vi.fn(),
    getConfigValues: () => configValues,
    setConfigValues: (next: Map<string, string | number>) => {
      configValues = next;
    },
  };
});

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => configuration,
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration: (key: string) => boolean }) => void) => {
      configListeners.push(listener);
      return { dispose: vi.fn() };
    },
  },
  window: {
    showQuickPick,
    showInputBox,
    showInformationMessage,
    showWarningMessage,
    showErrorMessage,
  },
  EventEmitter: class<T> {
    private listeners: Array<(event: T | undefined) => void> = [];

    event = (listener: (event: T | undefined) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };

    fire(event?: T) {
      this.listeners.forEach((listener) => listener(event));
    }

    dispose() {}
  },
}));

vi.mock('../../../src/storage/database', () => ({
  getEmbeddingConfigFingerprint,
  getEmbeddingDimensions,
  resetEmbeddingsTable,
  setEmbeddingConfigFingerprint,
}));

import { EmbeddingManager } from '../../../src/embedding/manager';

describe('EmbeddingManager', () => {
  let registry: any;
  let embeddingStore: any;
  let getDataSources: any;
  let queueReindexAll: any;
  let hasOpenAIKey: boolean;
  let hasAzureKey: boolean;
  let hasLocalKey: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    configListeners.length = 0;
    setConfigValues(new Map<string, string | number>([
      ['yoink.embedding.provider', 'openai'],
      ['yoink.embedding.openai.model', 'text-embedding-3-small'],
      ['yoink.embedding.openai.baseUrl', 'https://api.openai.com/v1'],
      ['yoink.embedding.azure.endpoint', 'https://azure.example.com'],
      ['yoink.embedding.azure.deploymentName', 'embed-prod'],
      ['yoink.embedding.azure.apiVersion', '2024-02-01'],
      ['yoink.embedding.azure.dimensions', 3072],
      ['yoink.embedding.local.baseUrl', 'http://localhost:11434/v1'],
      ['yoink.embedding.local.model', 'nomic-embed-text'],
      ['yoink.embedding.local.dimensions', 768],
    ]));

    hasOpenAIKey = true;
    hasAzureKey = false;
    hasLocalKey = false;

    registry = {
      getManagedSettingKeys: vi.fn().mockReturnValue([
        'yoink.embedding.provider',
        'yoink.embedding.openai.model',
        'yoink.embedding.openai.baseUrl',
        'yoink.embedding.azure.endpoint',
        'yoink.embedding.azure.deploymentName',
        'yoink.embedding.azure.apiVersion',
        'yoink.embedding.azure.dimensions',
        'yoink.embedding.local.baseUrl',
        'yoink.embedding.local.model',
        'yoink.embedding.local.dimensions',
      ]),
      onSecretsChanged: vi.fn().mockImplementation((listener: () => void) => {
        return { dispose: vi.fn(), listener };
      }),
      getConfigurationState: vi.fn().mockImplementation(async () => {
        const provider = configuration.get('yoink.embedding.provider', 'openai');
        if (provider === 'azure-openai') {
          return {
            provider,
            providerLabel: 'Azure OpenAI',
            identifier: String(configuration.get('yoink.embedding.azure.deploymentName', 'Azure OpenAI')),
            identifierLabel: 'Deployment',
            dimensions: Number(configuration.get('yoink.embedding.azure.dimensions', 1536)),
            requiresApiKey: true,
            hasApiKey: hasAzureKey,
            missingFields: hasAzureKey ? [] : ['API key'],
            isConfigured: hasAzureKey,
            fingerprint: 'fp-azure',
          };
        }
        if (provider === 'local') {
          return {
            provider,
            providerLabel: 'Local',
            identifier: String(configuration.get('yoink.embedding.local.model', 'Local model')),
            identifierLabel: 'Model',
            dimensions: Number(configuration.get('yoink.embedding.local.dimensions', 768)),
            requiresApiKey: false,
            hasApiKey: hasLocalKey,
            missingFields: [],
            isConfigured: true,
            fingerprint: 'fp-local',
          };
        }
        return {
          provider,
          providerLabel: 'OpenAI',
          identifier: String(configuration.get('yoink.embedding.openai.model', 'text-embedding-3-small')),
          identifierLabel: 'Model',
          dimensions: 1536,
          requiresApiKey: true,
          hasApiKey: hasOpenAIKey,
          missingFields: hasOpenAIKey ? [] : ['API key'],
          isConfigured: hasOpenAIKey,
          fingerprint: 'fp-openai',
        };
      }),
      setApiKey: vi.fn(async () => { hasOpenAIKey = true; }),
      setAzureApiKey: vi.fn(async () => { hasAzureKey = true; }),
      setLocalApiKey: vi.fn(async () => { hasLocalKey = true; }),
      clearLocalApiKey: vi.fn(async () => { hasLocalKey = false; }),
    };

    embeddingStore = {
      countAll: vi.fn().mockReturnValue(4),
      refreshAfterSchemaChange: vi.fn(),
    };
    getDataSources = vi.fn().mockReturnValue([{ id: 'ds-1' }, { id: 'ds-2' }]);
    queueReindexAll = vi.fn().mockResolvedValue(undefined);
    getEmbeddingConfigFingerprint.mockReturnValue('fp-openai');
    getEmbeddingDimensions.mockReturnValue(1536);
  });

  it('manages Azure embeddings and triggers a rebuild', async () => {
    showQuickPick
      .mockResolvedValueOnce({
        label: 'Azure OpenAI',
        description: 'Azure OpenAI deployment',
        provider: 'azure-openai',
      });
    showInputBox
      .mockResolvedValueOnce('https://myresource.openai.azure.com')
      .mockResolvedValueOnce('prod-embed')
      .mockResolvedValueOnce('2024-02-01')
      .mockResolvedValueOnce('3072')
      .mockResolvedValueOnce('azure-secret');

    const manager = new EmbeddingManager(
      registry,
      {} as any,
      embeddingStore,
      getDataSources,
      queueReindexAll,
    );

    await manager.manageEmbeddings();

    expect(configuration.update).toHaveBeenCalledWith('yoink.embedding.provider', 'azure-openai', 1);
    expect(configuration.update).toHaveBeenCalledWith(
      'yoink.embedding.azure.endpoint',
      'https://myresource.openai.azure.com',
      1,
    );
    expect(configuration.update).toHaveBeenCalledWith('yoink.embedding.azure.deploymentName', 'prod-embed', 1);
    expect(configuration.update).toHaveBeenCalledWith('yoink.embedding.azure.apiVersion', '2024-02-01', 1);
    expect(configuration.update).toHaveBeenCalledWith('yoink.embedding.azure.dimensions', 3072, 1);
    expect(registry.setAzureApiKey).toHaveBeenCalledWith('azure-secret');
    expect(resetEmbeddingsTable).toHaveBeenCalledWith(expect.anything(), 3072);
    expect(setEmbeddingConfigFingerprint).toHaveBeenCalledWith(expect.anything(), 'fp-azure');
    expect(queueReindexAll).toHaveBeenCalled();
  });

  it('prompts to rebuild on startup when settings drift is detected', async () => {
    getConfigValues().set('yoink.embedding.provider', 'azure-openai');
    hasAzureKey = true;
    getEmbeddingConfigFingerprint.mockReturnValue('fp-openai');
    getEmbeddingDimensions.mockReturnValue(1536);
    showInformationMessage.mockResolvedValue('Rebuild');

    const manager = new EmbeddingManager(
      registry,
      {} as any,
      embeddingStore,
      getDataSources,
      queueReindexAll,
    );

    await manager.initialize();

    expect(showInformationMessage).toHaveBeenCalledWith(
      'Yoink: Embedding settings changed via startup. Rebuild embeddings now?',
      'Rebuild',
      'Later',
    );
    expect(resetEmbeddingsTable).toHaveBeenCalledWith(expect.anything(), 3072);
    expect(queueReindexAll).toHaveBeenCalled();
  });

  it('reports stale status when the stored fingerprint no longer matches', async () => {
    getConfigValues().set('yoink.embedding.provider', 'azure-openai');
    hasAzureKey = true;
    getEmbeddingConfigFingerprint.mockReturnValue('fp-openai');
    getEmbeddingDimensions.mockReturnValue(1536);

    const manager = new EmbeddingManager(
      registry,
      {} as any,
      embeddingStore,
      getDataSources,
      queueReindexAll,
    );

    const status = await manager.getStatus();

    expect(status.isStale).toBe(true);
    expect(status.actionCommand).toBe('yoink.rebuildEmbeddings');
    expect(status.statusLabel).toBe('Rebuild required');
  });
});
