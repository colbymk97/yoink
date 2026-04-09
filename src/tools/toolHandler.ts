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
    options: vscode.LanguageModelToolInvocationOptions<{ query: string; repository?: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const readySources = this.configManager
      .getDataSources()
      .filter((ds) => ds.status === 'ready');

    if (readySources.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No repositories are indexed yet. Add a repository via the RepoLens sidebar and wait for indexing to complete.',
        ),
      ]);
    }

    let targetIds: string[];
    const repoFilter = options.input.repository?.toLowerCase();

    if (repoFilter) {
      const matched = readySources.filter(
        (ds) =>
          `${ds.owner}/${ds.repo}`.toLowerCase() === repoFilter ||
          ds.repo.toLowerCase() === repoFilter,
      );
      if (matched.length === 0) {
        const available = readySources.map((ds) => `${ds.owner}/${ds.repo}`).join(', ');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Repository "${options.input.repository}" is not indexed. Indexed repositories: ${available}`,
          ),
        ]);
      }
      targetIds = matched.map((ds) => ds.id);
    } else {
      targetIds = readySources.map((ds) => ds.id);
    }

    const searchedRepos = readySources
      .filter((ds) => targetIds.includes(ds.id))
      .map((ds) => `${ds.owner}/${ds.repo}`)
      .join(', ');

    return this.executeSearch(options.input.query, targetIds, searchedRepos);
  }

  private async executeSearch(
    query: string,
    dataSourceIds: string[],
    searchedRepos?: string,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const topK = vscode.workspace
        .getConfiguration()
        .get<number>(SETTING_KEYS.SEARCH_TOP_K, 10);

      const provider = await this.providerRegistry.getProvider();
      const results = await this.retriever.search(query, dataSourceIds, provider, topK);
      const formatted = this.contextBuilder.format(results);

      const header = searchedRepos
        ? `*Searched repositories: ${searchedRepos}*\n\n`
        : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(header + formatted),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Search failed: ${message}`),
      ]);
    }
  }
}
