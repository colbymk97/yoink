import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { EmbeddingProviderRegistry } from '../embedding/registry';
import { Retriever } from '../retrieval/retriever';
import { ContextBuilder } from '../retrieval/contextBuilder';
import { SETTING_KEYS } from '../config/settingsSchema';

export class ToolHandler {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly providerRegistry: EmbeddingProviderRegistry,
    private readonly retriever: Retriever,
    private readonly contextBuilder: ContextBuilder,
  ) {}

  async handle(
    toolId: string,
    options: vscode.LanguageModelToolInvocationOptions<{ query: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const tool = this.configManager.getTool(toolId);
    if (!tool) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Tool "${toolId}" not found.`),
      ]);
    }

    return this.executeSearch(options.input.query, tool.dataSourceIds);
  }

  async handleGlobalSearch(
    options: vscode.LanguageModelToolInvocationOptions<{ query: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const allDataSourceIds = this.configManager
      .getDataSources()
      .filter((ds) => ds.status === 'ready')
      .map((ds) => ds.id);

    return this.executeSearch(options.input.query, allDataSourceIds);
  }

  private async executeSearch(
    query: string,
    dataSourceIds: string[],
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const topK = vscode.workspace
        .getConfiguration()
        .get<number>(SETTING_KEYS.SEARCH_TOP_K, 10);

      const provider = await this.providerRegistry.getProvider();
      const results = await this.retriever.search(query, dataSourceIds, provider, topK);
      const formatted = this.contextBuilder.format(results);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(formatted),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Search failed: ${message}`),
      ]);
    }
  }
}
