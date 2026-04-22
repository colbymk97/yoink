import * as vscode from 'vscode';
import { EmbeddingProvider } from './embeddingProvider';
import { OpenAIEmbeddingProvider } from './openaiProvider';
import { AzureOpenAIEmbeddingProvider } from './azureOpenAIProvider';
import { LocalEmbeddingProvider } from './localProvider';
import { SETTING_KEYS } from '../config/settingsSchema';
import { createHash } from 'node:crypto';

export type EmbeddingProviderType = 'openai' | 'azure-openai' | 'local';

export interface EmbeddingConfigurationState {
  provider: EmbeddingProviderType;
  providerLabel: string;
  identifier: string;
  identifierLabel: string;
  dimensions: number;
  requiresApiKey: boolean;
  hasApiKey: boolean;
  missingFields: string[];
  isConfigured: boolean;
  fingerprint?: string;
}

const OPENAI_MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export class EmbeddingProviderRegistry {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async getProvider(): Promise<EmbeddingProvider> {
    const config = vscode.workspace.getConfiguration();
    const providerType = this.getProviderType(config);

    switch (providerType) {
      case 'openai':
        return this.createOpenAIProvider(config);
      case 'azure-openai':
        return this.createAzureProvider(config);
      case 'local':
        return this.createLocalProvider(config);
      default:
        throw new Error(`Unknown embedding provider: ${providerType}`);
    }
  }

  getProviderType(
    config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(),
  ): EmbeddingProviderType {
    return config.get<EmbeddingProviderType>(SETTING_KEYS.EMBEDDING_PROVIDER, 'openai');
  }

  async getConfigurationState(
    config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(),
  ): Promise<EmbeddingConfigurationState> {
    const provider = this.getProviderType(config);

    if (provider === 'azure-openai') {
      const endpoint = config.get<string>(SETTING_KEYS.AZURE_ENDPOINT, '').trim();
      const deploymentName = config.get<string>(SETTING_KEYS.AZURE_DEPLOYMENT_NAME, '').trim();
      const apiVersion = config.get<string>(SETTING_KEYS.AZURE_API_VERSION, '2024-02-01').trim();
      const dimensions = config.get<number>(SETTING_KEYS.AZURE_DIMENSIONS, 1536);
      const hasApiKey = await this.hasAzureApiKey();
      const missingFields = [
        ...(endpoint ? [] : ['endpoint']),
        ...(deploymentName ? [] : ['deployment name']),
        ...(apiVersion ? [] : ['API version']),
        ...(Number.isFinite(dimensions) && dimensions > 0 ? [] : ['dimensions']),
        ...(hasApiKey ? [] : ['API key']),
      ];

      return {
        provider,
        providerLabel: 'Azure OpenAI',
        identifier: deploymentName || 'Azure OpenAI',
        identifierLabel: 'Deployment',
        dimensions,
        requiresApiKey: true,
        hasApiKey,
        missingFields,
        isConfigured: missingFields.length === 0,
        fingerprint: endpoint && deploymentName && apiVersion && dimensions > 0
          ? this.fingerprintFor({
            provider,
            endpoint,
            deploymentName,
            apiVersion,
            dimensions,
          })
          : undefined,
      };
    }

    if (provider === 'local') {
      const baseUrl = config.get<string>(SETTING_KEYS.LOCAL_BASE_URL, 'http://localhost:11434/v1').trim();
      const model = config.get<string>(SETTING_KEYS.LOCAL_MODEL, '').trim();
      const dimensions = config.get<number>(SETTING_KEYS.LOCAL_DIMENSIONS, 768);
      const hasApiKey = await this.hasLocalApiKey();
      const missingFields = [
        ...(baseUrl ? [] : ['base URL']),
        ...(model ? [] : ['model']),
        ...(Number.isFinite(dimensions) && dimensions > 0 ? [] : ['dimensions']),
      ];

      return {
        provider,
        providerLabel: 'Local',
        identifier: model || 'Local model',
        identifierLabel: 'Model',
        dimensions,
        requiresApiKey: false,
        hasApiKey,
        missingFields,
        isConfigured: missingFields.length === 0,
        fingerprint: baseUrl && model && dimensions > 0
          ? this.fingerprintFor({
            provider,
            baseUrl,
            model,
            dimensions,
          })
          : undefined,
      };
    }

    const model = config.get<string>(SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small').trim();
    const baseUrl = config.get<string>(SETTING_KEYS.OPENAI_BASE_URL, 'https://api.openai.com/v1').trim();
    const dimensions = getOpenAIModelDimensions(model);
    const hasApiKey = await this.hasApiKey();
    const missingFields = [
      ...(model ? [] : ['model']),
      ...(baseUrl ? [] : ['base URL']),
      ...(hasApiKey ? [] : ['API key']),
    ];

    return {
      provider,
      providerLabel: 'OpenAI',
      identifier: model || 'OpenAI',
      identifierLabel: 'Model',
      dimensions,
      requiresApiKey: true,
      hasApiKey,
      missingFields,
      isConfigured: missingFields.length === 0,
      fingerprint: model && baseUrl
        ? this.fingerprintFor({
          provider,
          model,
          baseUrl,
          dimensions,
        })
        : undefined,
    };
  }

  getManagedSettingKeys(): string[] {
    return [
      SETTING_KEYS.EMBEDDING_PROVIDER,
      SETTING_KEYS.OPENAI_MODEL,
      SETTING_KEYS.OPENAI_BASE_URL,
      SETTING_KEYS.AZURE_ENDPOINT,
      SETTING_KEYS.AZURE_DEPLOYMENT_NAME,
      SETTING_KEYS.AZURE_API_VERSION,
      SETTING_KEYS.AZURE_DIMENSIONS,
      SETTING_KEYS.LOCAL_BASE_URL,
      SETTING_KEYS.LOCAL_MODEL,
      SETTING_KEYS.LOCAL_DIMENSIONS,
    ];
  }

  onSecretsChanged(listener: () => void): vscode.Disposable {
    return this.secretStorage.onDidChange(() => listener());
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────

  private async createOpenAIProvider(
    config: vscode.WorkspaceConfiguration,
  ): Promise<OpenAIEmbeddingProvider> {
    const apiKey = await this.resolveOpenAIApiKey();
    if (!apiKey) {
      throw new Error(
        'OpenAI API key not configured. Run "Yoink: Set OpenAI API Key" or set the OPENAI_API_KEY environment variable.',
      );
    }

    return new OpenAIEmbeddingProvider({
      apiKey,
      model: config.get<string>(SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small'),
      baseUrl: config.get<string>(SETTING_KEYS.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
    });
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.resolveOpenAIApiKey()) !== undefined;
  }

  private async resolveOpenAIApiKey(): Promise<string | undefined> {
    const stored = await this.secretStorage.get('yoink.openai.apiKey');
    if (stored) return stored;

    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) return envKey;

    return undefined;
  }

  async setApiKey(key: string): Promise<void> {
    await this.secretStorage.store('yoink.openai.apiKey', key);
  }

  async clearApiKey(): Promise<void> {
    await this.secretStorage.delete('yoink.openai.apiKey');
  }

  // ── Azure OpenAI ──────────────────────────────────────────────────────────

  private async createAzureProvider(
    config: vscode.WorkspaceConfiguration,
  ): Promise<AzureOpenAIEmbeddingProvider> {
    const apiKey = await this.resolveAzureApiKey();
    if (!apiKey) {
      throw new Error(
        'Azure OpenAI API key not configured. Run "Yoink: Set Azure OpenAI API Key" or set the AZURE_OPENAI_API_KEY environment variable.',
      );
    }

    const endpoint = config.get<string>(SETTING_KEYS.AZURE_ENDPOINT, '');
    if (!endpoint) {
      throw new Error(
        'Azure OpenAI endpoint not configured. Set "yoink.embedding.azure.endpoint" in VS Code settings.',
      );
    }

    const deploymentName = config.get<string>(SETTING_KEYS.AZURE_DEPLOYMENT_NAME, '');
    if (!deploymentName) {
      throw new Error(
        'Azure OpenAI deployment name not configured. Set "yoink.embedding.azure.deploymentName" in VS Code settings.',
      );
    }

    return new AzureOpenAIEmbeddingProvider({
      apiKey,
      endpoint,
      deploymentName,
      apiVersion: config.get<string>(SETTING_KEYS.AZURE_API_VERSION, '2024-02-01'),
      dimensions: config.get<number>(SETTING_KEYS.AZURE_DIMENSIONS, 1536),
    });
  }

  async hasAzureApiKey(): Promise<boolean> {
    return (await this.resolveAzureApiKey()) !== undefined;
  }

  private async resolveAzureApiKey(): Promise<string | undefined> {
    const stored = await this.secretStorage.get('yoink.azure.apiKey');
    if (stored) return stored;

    const envKey = process.env.AZURE_OPENAI_API_KEY;
    if (envKey) return envKey;

    return undefined;
  }

  async setAzureApiKey(key: string): Promise<void> {
    await this.secretStorage.store('yoink.azure.apiKey', key);
  }

  async clearAzureApiKey(): Promise<void> {
    await this.secretStorage.delete('yoink.azure.apiKey');
  }

  // ── Local ─────────────────────────────────────────────────────────────────

  private async createLocalProvider(
    config: vscode.WorkspaceConfiguration,
  ): Promise<LocalEmbeddingProvider> {
    const model = config.get<string>(SETTING_KEYS.LOCAL_MODEL, '');
    if (!model) {
      throw new Error(
        'Local embedding model not configured. Set "yoink.embedding.local.model" in VS Code settings.',
      );
    }

    // Optional API key for local servers that require one
    const apiKey = await this.secretStorage.get('yoink.local.apiKey') ??
      process.env.LOCAL_EMBEDDING_API_KEY;

    return new LocalEmbeddingProvider({
      baseUrl: config.get<string>(SETTING_KEYS.LOCAL_BASE_URL, 'http://localhost:11434/v1'),
      model,
      dimensions: config.get<number>(SETTING_KEYS.LOCAL_DIMENSIONS, 768),
      apiKey: apiKey || undefined,
    });
  }

  async hasLocalApiKey(): Promise<boolean> {
    const stored = await this.secretStorage.get('yoink.local.apiKey');
    return Boolean(stored ?? process.env.LOCAL_EMBEDDING_API_KEY);
  }

  async setLocalApiKey(key: string): Promise<void> {
    await this.secretStorage.store('yoink.local.apiKey', key);
  }

  async clearLocalApiKey(): Promise<void> {
    await this.secretStorage.delete('yoink.local.apiKey');
  }

  private fingerprintFor(payload: Record<string, string | number>): string {
    return createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
  }
}

export function getOpenAIModelDimensions(model: string): number {
  return OPENAI_MODEL_DIMENSIONS[model] ?? 1536;
}
