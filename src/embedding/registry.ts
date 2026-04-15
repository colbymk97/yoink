import * as vscode from 'vscode';
import { EmbeddingProvider } from './embeddingProvider';
import { OpenAIEmbeddingProvider } from './openaiProvider';
import { AzureOpenAIEmbeddingProvider } from './azureOpenAIProvider';
import { LocalEmbeddingProvider } from './localProvider';
import { SETTING_KEYS } from '../config/settingsSchema';

export class EmbeddingProviderRegistry {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async getProvider(): Promise<EmbeddingProvider> {
    const config = vscode.workspace.getConfiguration();
    const providerType = config.get<string>(SETTING_KEYS.EMBEDDING_PROVIDER, 'openai');

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
}
