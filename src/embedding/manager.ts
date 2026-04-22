import * as vscode from 'vscode';
import type Database from 'better-sqlite3';
import { DataSourceConfig } from '../config/configSchema';
import { SETTING_KEYS } from '../config/settingsSchema';
import {
  EmbeddingConfigurationState,
  EmbeddingProviderRegistry,
  EmbeddingProviderType,
} from './registry';
import {
  getEmbeddingConfigFingerprint,
  getEmbeddingDimensions,
  resetEmbeddingsTable,
  setEmbeddingConfigFingerprint,
} from '../storage/database';
import { EmbeddingStore } from '../storage/embeddingStore';

interface EmbeddingAssessment {
  config: EmbeddingConfigurationState;
  storedFingerprint?: string;
  storedDimensions: number;
  hasEmbeddings: boolean;
  isStale: boolean;
}

export interface EmbeddingStatus extends EmbeddingConfigurationState {
  isRebuilding: boolean;
  isStale: boolean;
  statusLabel: string;
  actionCommand: 'yoink.manageEmbeddings' | 'yoink.rebuildEmbeddings';
  tooltip: string;
}

interface ManageEmbeddingResult {
  provider: EmbeddingProviderType;
  settings: Array<{ key: string; value: string | number }>;
  secretUpdates: Array<{ kind: 'openai' | 'azure' | 'local'; value?: string }>;
}

export class EmbeddingManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly configListener: vscode.Disposable;
  private readonly secretsListener: vscode.Disposable;
  private rebuilding = false;
  private suppressConfigEvents = false;
  private stalePromptKey?: string;

  constructor(
    private readonly registry: EmbeddingProviderRegistry,
    private readonly db: Database.Database,
    private readonly embeddingStore: EmbeddingStore,
    private readonly getDataSources: () => readonly DataSourceConfig[],
    private readonly queueReindexAll: () => Promise<void>,
    private readonly messagePrefix = 'Yoink',
  ) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.suppressConfigEvents) return;
      const isRelevant = this.registry.getManagedSettingKeys()
        .some((key) => event.affectsConfiguration(key));
      if (!isRelevant) return;
      void this.handleConfigurationDrift('settings update');
    });
    this.secretsListener = this.registry.onSecretsChanged(() => this.refresh());
  }

  async initialize(): Promise<void> {
    await this.handleConfigurationDrift('startup');
  }

  async ensureConfigured(): Promise<boolean> {
    const status = await this.getStatus();
    if (status.isConfigured) {
      return true;
    }

    const action = await vscode.window.showErrorMessage(
      `${this.messagePrefix}: Embeddings are not configured (${status.missingFields.join(', ')}).`,
      'Manage Embeddings',
    );
    if (action === 'Manage Embeddings') {
      return this.manageEmbeddings();
    }

    return false;
  }

  async manageEmbeddings(): Promise<boolean> {
    const current = await this.registry.getConfigurationState();
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: 'OpenAI',
          description: 'Hosted OpenAI embedding API',
          provider: 'openai' as const,
        },
        {
          label: 'Azure OpenAI',
          description: 'Azure OpenAI deployment',
          provider: 'azure-openai' as const,
        },
        {
          label: 'Local',
          description: 'OpenAI-compatible local server',
          provider: 'local' as const,
        },
      ],
      {
        title: 'Yoink: Manage Embeddings',
        placeHolder: 'Choose an embedding provider',
        ignoreFocusOut: true,
      },
    );
    if (!choice) return false;

    const result = await this.promptForProvider(choice.provider, current);
    if (!result) return false;

    const before = await this.assessState();
    await this.applyManagedConfig(result);
    const after = await this.assessState();

    this.refresh();

    if (!after.config.isConfigured) {
      return false;
    }

    const changed = before.storedFingerprint !== after.config.fingerprint ||
      before.storedDimensions !== after.config.dimensions;
    if (!changed) {
      await this.adoptCurrentFingerprintIfNeeded(after);
      vscode.window.showInformationMessage(`${this.messagePrefix}: Embedding settings saved.`);
      return true;
    }

    await this.rebuildEmbeddings({
      reason: 'updated embedding settings',
      skipConfirmation: true,
      skipManageOnFailure: true,
    });
    return true;
  }

  async rebuildEmbeddings(options?: {
    reason?: string;
    skipConfirmation?: boolean;
    skipManageOnFailure?: boolean;
  }): Promise<boolean> {
    if (this.rebuilding) {
      vscode.window.showInformationMessage(`${this.messagePrefix}: Embedding rebuild already in progress.`);
      return false;
    }

    const assessment = await this.assessState();
    if (!assessment.config.isConfigured || !assessment.config.fingerprint) {
      if (options?.skipManageOnFailure) {
        vscode.window.showErrorMessage(
          `${this.messagePrefix}: Embeddings are not configured (${assessment.config.missingFields.join(', ')}).`,
        );
        return false;
      }
      return this.ensureConfigured();
    }

    if (!options?.skipConfirmation) {
      const action = await vscode.window.showWarningMessage(
        `${this.messagePrefix}: Rebuild embeddings for all indexed repositories? Existing vectors will be cleared first.`,
        { modal: true },
        'Rebuild',
      );
      if (action !== 'Rebuild') {
        return false;
      }
    }

    this.rebuilding = true;
    this.refresh();

    try {
      resetEmbeddingsTable(this.db, assessment.config.dimensions);
      this.embeddingStore.refreshAfterSchemaChange();
      setEmbeddingConfigFingerprint(this.db, assessment.config.fingerprint);
      this.stalePromptKey = undefined;

      const dataSources = this.getDataSources();
      if (dataSources.length === 0) {
        vscode.window.showInformationMessage(`${this.messagePrefix}: Embedding settings saved. No repositories to reindex.`);
        return true;
      }

      await this.queueReindexAll();
      const suffix = options?.reason ? ` after ${options.reason}` : '';
      vscode.window.showInformationMessage(
        `${this.messagePrefix}: Rebuilding embeddings for ${dataSources.length} ${dataSources.length === 1 ? 'repository' : 'repositories'}${suffix}.`,
      );
      return true;
    } finally {
      this.rebuilding = false;
      this.refresh();
    }
  }

  async getStatus(): Promise<EmbeddingStatus> {
    const assessment = await this.assessState();
    const lines = [
      `${assessment.config.providerLabel} ${assessment.config.identifierLabel}: ${assessment.config.identifier}`,
      `Dimensions: ${assessment.config.dimensions}`,
    ];

    let statusLabel = 'Configured';
    let actionCommand: 'yoink.manageEmbeddings' | 'yoink.rebuildEmbeddings' = 'yoink.manageEmbeddings';

    if (this.rebuilding) {
      statusLabel = 'Rebuilding…';
      actionCommand = 'yoink.rebuildEmbeddings';
      lines.push('Status: rebuild in progress');
    } else if (!assessment.config.isConfigured) {
      statusLabel = `Setup required: ${assessment.config.missingFields.join(', ')}`;
      lines.push(`Missing: ${assessment.config.missingFields.join(', ')}`);
    } else if (assessment.isStale) {
      statusLabel = 'Rebuild required';
      actionCommand = 'yoink.rebuildEmbeddings';
      lines.push('Status: settings changed since the current embeddings were built');
    } else {
      lines.push('Status: configured');
    }

    if (assessment.config.requiresApiKey) {
      lines.push(`API key: ${assessment.config.hasApiKey ? 'configured' : 'missing'}`);
    } else if (assessment.config.hasApiKey) {
      lines.push('API key: configured');
    }

    return {
      ...assessment.config,
      isRebuilding: this.rebuilding,
      isStale: assessment.isStale,
      statusLabel,
      actionCommand,
      tooltip: lines.join('\n'),
    };
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this.configListener.dispose();
    this.secretsListener.dispose();
    this._onDidChange.dispose();
  }

  private async handleConfigurationDrift(source: string): Promise<void> {
    const assessment = await this.assessState();

    if (!assessment.config.isConfigured || !assessment.config.fingerprint) {
      this.refresh();
      return;
    }

    if (!assessment.storedFingerprint) {
      if (!assessment.isStale) {
        await this.adoptCurrentFingerprintIfNeeded(assessment);
        this.refresh();
        return;
      }
    }

    if (!assessment.isStale) {
      this.stalePromptKey = undefined;
      this.refresh();
      return;
    }

    const dataSources = this.getDataSources();
    if (dataSources.length === 0) {
      resetEmbeddingsTable(this.db, assessment.config.dimensions);
      this.embeddingStore.refreshAfterSchemaChange();
      setEmbeddingConfigFingerprint(this.db, assessment.config.fingerprint);
      this.refresh();
      return;
    }

    const promptKey = `${assessment.storedFingerprint}:${assessment.config.fingerprint}:${assessment.storedDimensions}:${assessment.config.dimensions}`;
    if (this.stalePromptKey === promptKey) {
      this.refresh();
      return;
    }

    this.stalePromptKey = promptKey;
    this.refresh();

    const action = await vscode.window.showInformationMessage(
      `${this.messagePrefix}: Embedding settings changed via ${source}. Rebuild embeddings now?`,
      'Rebuild',
      'Later',
    );
    if (action === 'Rebuild') {
      await this.rebuildEmbeddings({
        reason: source,
        skipConfirmation: true,
        skipManageOnFailure: true,
      });
    }
  }

  private async adoptCurrentFingerprintIfNeeded(assessment: EmbeddingAssessment): Promise<void> {
    if (!assessment.config.fingerprint) return;

    if (!assessment.hasEmbeddings || assessment.storedDimensions === assessment.config.dimensions) {
      setEmbeddingConfigFingerprint(this.db, assessment.config.fingerprint);
    }
  }

  private async assessState(): Promise<EmbeddingAssessment> {
    const config = await this.registry.getConfigurationState();
    const storedFingerprint = getEmbeddingConfigFingerprint(this.db);
    const storedDimensions = getEmbeddingDimensions(this.db);
    const hasEmbeddings = this.embeddingStore.countAll() > 0;
    const fingerprintChanged = Boolean(
      config.isConfigured &&
      config.fingerprint &&
      storedFingerprint &&
      storedFingerprint !== config.fingerprint,
    );
    const dimensionChanged = Boolean(
      config.isConfigured &&
      hasEmbeddings &&
      storedDimensions !== config.dimensions,
    );
    const isStale = fingerprintChanged || dimensionChanged;

    return {
      config,
      storedFingerprint,
      storedDimensions,
      hasEmbeddings,
      isStale,
    };
  }

  private async applyManagedConfig(result: ManageEmbeddingResult): Promise<void> {
    const config = vscode.workspace.getConfiguration();

    this.suppressConfigEvents = true;
    try {
      await config.update(SETTING_KEYS.EMBEDDING_PROVIDER, result.provider, vscode.ConfigurationTarget.Global);
      for (const setting of result.settings) {
        await config.update(setting.key, setting.value, vscode.ConfigurationTarget.Global);
      }
      for (const secret of result.secretUpdates) {
        await this.applySecret(secret);
      }
    } finally {
      this.suppressConfigEvents = false;
    }
  }

  private async applySecret(secret: { kind: 'openai' | 'azure' | 'local'; value?: string }): Promise<void> {
    if (secret.kind === 'openai') {
      if (secret.value === undefined) return;
      await this.registry.setApiKey(secret.value);
      return;
    }

    if (secret.kind === 'azure') {
      if (secret.value === undefined) return;
      await this.registry.setAzureApiKey(secret.value);
      return;
    }

    if (secret.value === undefined) {
      return;
    }

    if (secret.value === '') {
      await this.registry.clearLocalApiKey();
      return;
    }

    await this.registry.setLocalApiKey(secret.value);
  }

  private async promptForProvider(
    provider: EmbeddingProviderType,
    current: EmbeddingConfigurationState,
  ): Promise<ManageEmbeddingResult | undefined> {
    if (provider === 'azure-openai') {
      const endpoint = await vscode.window.showInputBox({
        title: 'Yoink: Azure OpenAI (1/5)',
        prompt: 'Azure OpenAI endpoint URL',
        value: current.provider === 'azure-openai'
          ? (vscode.workspace.getConfiguration().get<string>(SETTING_KEYS.AZURE_ENDPOINT, ''))
          : '',
        placeHolder: 'https://myresource.openai.azure.com',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'Endpoint is required',
      });
      if (endpoint === undefined) return undefined;

      const deploymentName = await vscode.window.showInputBox({
        title: 'Yoink: Azure OpenAI (2/5)',
        prompt: 'Deployment name',
        value: current.provider === 'azure-openai'
          ? vscode.workspace.getConfiguration().get<string>(SETTING_KEYS.AZURE_DEPLOYMENT_NAME, '')
          : '',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'Deployment name is required',
      });
      if (deploymentName === undefined) return undefined;

      const apiVersion = await vscode.window.showInputBox({
        title: 'Yoink: Azure OpenAI (3/5)',
        prompt: 'API version',
        value: current.provider === 'azure-openai'
          ? vscode.workspace.getConfiguration().get<string>(SETTING_KEYS.AZURE_API_VERSION, '2024-02-01')
          : '2024-02-01',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'API version is required',
      });
      if (apiVersion === undefined) return undefined;

      const dimensionsInput = await vscode.window.showInputBox({
        title: 'Yoink: Azure OpenAI (4/5)',
        prompt: 'Embedding dimensions',
        value: String(
          current.provider === 'azure-openai'
            ? vscode.workspace.getConfiguration().get<number>(SETTING_KEYS.AZURE_DIMENSIONS, 1536)
            : 1536,
        ),
        ignoreFocusOut: true,
        validateInput: validatePositiveInteger,
      });
      if (dimensionsInput === undefined) return undefined;

      const apiKey = await this.promptRequiredApiKey(
        'Azure OpenAI',
        current.provider === 'azure-openai' ? current.hasApiKey : false,
        'Yoink: Azure OpenAI (5/5)',
      );
      if (apiKey === undefined) return undefined;

      return {
        provider,
        settings: [
          { key: SETTING_KEYS.AZURE_ENDPOINT, value: endpoint.trim() },
          { key: SETTING_KEYS.AZURE_DEPLOYMENT_NAME, value: deploymentName.trim() },
          { key: SETTING_KEYS.AZURE_API_VERSION, value: apiVersion.trim() },
          { key: SETTING_KEYS.AZURE_DIMENSIONS, value: parseInt(dimensionsInput, 10) },
        ],
        secretUpdates: [{ kind: 'azure', value: apiKey }],
      };
    }

    if (provider === 'local') {
      const baseUrl = await vscode.window.showInputBox({
        title: 'Yoink: Local Embeddings (1/3)',
        prompt: 'Local embedding server base URL',
        value: current.provider === 'local'
          ? vscode.workspace.getConfiguration().get<string>(SETTING_KEYS.LOCAL_BASE_URL, 'http://localhost:11434/v1')
          : 'http://localhost:11434/v1',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'Base URL is required',
      });
      if (baseUrl === undefined) return undefined;

      const model = await vscode.window.showInputBox({
        title: 'Yoink: Local Embeddings (2/3)',
        prompt: 'Model name',
        value: current.provider === 'local'
          ? vscode.workspace.getConfiguration().get<string>(SETTING_KEYS.LOCAL_MODEL, '')
          : '',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'Model is required',
      });
      if (model === undefined) return undefined;

      const dimensionsInput = await vscode.window.showInputBox({
        title: 'Yoink: Local Embeddings (3/3)',
        prompt: 'Embedding dimensions',
        value: String(
          current.provider === 'local'
            ? vscode.workspace.getConfiguration().get<number>(SETTING_KEYS.LOCAL_DIMENSIONS, 768)
            : 768,
        ),
        ignoreFocusOut: true,
        validateInput: validatePositiveInteger,
      });
      if (dimensionsInput === undefined) return undefined;

      const localApiKey = await this.promptOptionalLocalApiKey(current.provider === 'local' ? current.hasApiKey : false);
      if (localApiKey === undefined) return undefined;

      return {
        provider,
        settings: [
          { key: SETTING_KEYS.LOCAL_BASE_URL, value: baseUrl.trim() },
          { key: SETTING_KEYS.LOCAL_MODEL, value: model.trim() },
          { key: SETTING_KEYS.LOCAL_DIMENSIONS, value: parseInt(dimensionsInput, 10) },
        ],
        secretUpdates: [{ kind: 'local', value: localApiKey }],
      };
    }

    const model = await vscode.window.showInputBox({
      title: 'Yoink: OpenAI Embeddings (1/3)',
      prompt: 'OpenAI model',
      value: current.provider === 'openai'
        ? vscode.workspace.getConfiguration().get<string>(SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small')
        : 'text-embedding-3-small',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'Model is required',
    });
    if (model === undefined) return undefined;

    const baseUrl = await vscode.window.showInputBox({
      title: 'Yoink: OpenAI Embeddings (2/3)',
      prompt: 'OpenAI base URL',
      value: current.provider === 'openai'
        ? vscode.workspace.getConfiguration().get<string>(SETTING_KEYS.OPENAI_BASE_URL, 'https://api.openai.com/v1')
        : 'https://api.openai.com/v1',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'Base URL is required',
    });
    if (baseUrl === undefined) return undefined;

    const apiKey = await this.promptRequiredApiKey(
      'OpenAI',
      current.provider === 'openai' ? current.hasApiKey : false,
      'Yoink: OpenAI Embeddings (3/3)',
    );
    if (apiKey === undefined) return undefined;

    return {
      provider,
      settings: [
        { key: SETTING_KEYS.OPENAI_MODEL, value: model.trim() },
        { key: SETTING_KEYS.OPENAI_BASE_URL, value: baseUrl.trim() },
      ],
      secretUpdates: [{ kind: 'openai', value: apiKey }],
    };
  }

  private async promptRequiredApiKey(
    providerLabel: string,
    hasExisting: boolean,
    title: string,
  ): Promise<string | undefined> {
    if (hasExisting) {
      const action = await vscode.window.showQuickPick<{ label: string; value: 'keep' | 'update' }>(
        [
          { label: 'Keep existing API key', value: 'keep' as const },
          { label: `Update ${providerLabel} API key`, value: 'update' as const },
        ],
        {
          title,
          placeHolder: `${providerLabel} API key`,
          ignoreFocusOut: true,
        },
      );
      if (!action) return undefined;
      if (action.value === 'keep') return undefined;
    }

    const key = await vscode.window.showInputBox({
      title,
      prompt: `Enter your ${providerLabel} API key`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'API key cannot be empty',
    });
    if (!key) return undefined;
    return key.trim();
  }

  private async promptOptionalLocalApiKey(hasExisting: boolean): Promise<string | undefined> {
    const actionItems: Array<{ label: string; value: 'keep' | 'update' | 'clear' | 'none' }> = hasExisting
        ? [
          { label: 'Keep existing API key', value: 'keep' as const },
          { label: 'Set a new API key', value: 'update' as const },
          { label: 'Remove API key', value: 'clear' as const },
        ]
        : [
          { label: 'No API key', value: 'none' as const },
          { label: 'Set API key', value: 'update' as const },
        ];

    const action = await vscode.window.showQuickPick(
      actionItems,
      {
        title: 'Yoink: Local Embeddings (API Key)',
        placeHolder: 'Optional local API key',
        ignoreFocusOut: true,
      },
    );
    if (!action) return undefined;
    if (action.value === 'keep' || action.value === 'none') return undefined;
    if (action.value === 'clear') return '';

    const key = await vscode.window.showInputBox({
      title: 'Yoink: Local Embeddings (API Key)',
      prompt: 'Enter the local embedding API key',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'API key cannot be empty',
    });
    if (!key) return undefined;
    return key.trim();
  }
}

function validatePositiveInteger(value: string): string | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? null : 'Enter a positive integer';
}
