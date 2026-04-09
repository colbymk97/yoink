import * as vscode from 'vscode';
import { EmbeddingProvider } from './embeddingProvider';
import { OpenAIEmbeddingProvider } from './openaiProvider';
import { SETTING_KEYS } from '../config/settingsSchema';

export class EmbeddingProviderRegistry {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async getProvider(): Promise<EmbeddingProvider> {
    const config = vscode.workspace.getConfiguration();
    const providerType = config.get<string>(SETTING_KEYS.EMBEDDING_PROVIDER, 'openai');

    switch (providerType) {
      case 'openai':
        return this.createOpenAIProvider(config);
      default:
        throw new Error(`Unknown embedding provider: ${providerType}`);
    }
  }

  private async createOpenAIProvider(
    config: vscode.WorkspaceConfiguration,
  ): Promise<OpenAIEmbeddingProvider> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      throw new Error(
        'OpenAI API key not configured. Run "RepoLens: Set OpenAI API Key" or set the OPENAI_API_KEY environment variable.',
      );
    }

    return new OpenAIEmbeddingProvider({
      apiKey,
      model: config.get<string>(SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small'),
      baseUrl: config.get<string>(SETTING_KEYS.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
    });
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.resolveApiKey()) !== undefined;
  }

  private async resolveApiKey(): Promise<string | undefined> {
    // 1. SecretStorage (primary)
    const stored = await this.secretStorage.get('repoLens.openai.apiKey');
    if (stored) return stored;

    // 2. Environment variable (fallback)
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) return envKey;

    return undefined;
  }

  async setApiKey(key: string): Promise<void> {
    await this.secretStorage.store('repoLens.openai.apiKey', key);
  }

  async clearApiKey(): Promise<void> {
    await this.secretStorage.delete('repoLens.openai.apiKey');
  }
}
