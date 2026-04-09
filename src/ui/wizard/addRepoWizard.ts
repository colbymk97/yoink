import * as vscode from 'vscode';
import { parseRepoUrl, isRepoUrlResult, GitHubResolver } from '../../sources/github/githubResolver';
import { RepoBrowser } from '../../sources/github/repoBrowser';
import { DataSourceManager, AddDataSourceOptions } from '../../sources/dataSourceManager';
import { DEFAULT_EXCLUDE_PATTERNS, ToolConfig } from '../../config/configSchema';
import { ConfigManager } from '../../config/configManager';
import { EmbeddingProviderRegistry } from '../../embedding/registry';
import * as crypto from 'crypto';

export class AddRepoWizard {
  constructor(
    private readonly resolver: GitHubResolver,
    private readonly browser: RepoBrowser,
    private readonly dataSourceManager: DataSourceManager,
    private readonly configManager: ConfigManager,
    private readonly embeddingRegistry: EmbeddingProviderRegistry,
  ) {}

  async run(): Promise<void> {
    // Step 0: Ensure API key is configured
    if (!(await this.embeddingRegistry.hasApiKey())) {
      const apiKey = await vscode.window.showInputBox({
        title: 'RepoLens: OpenAI API Key Required',
        prompt: 'Enter your OpenAI API key to enable embeddings',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? null : 'API key cannot be empty',
      });
      if (!apiKey) return;
      await this.embeddingRegistry.setApiKey(apiKey.trim());
    }

    // Step 1: Get repo URL or search
    const repoInput = await this.getRepoInput();
    if (!repoInput) return;

    // Step 2: Resolve repo metadata
    const metadata = await this.resolver.resolve(repoInput.owner, repoInput.repo);

    // Early duplicate check (against default branch; refined after branch selection)
    if (this.dataSourceManager.isDuplicate(metadata.owner, metadata.repo, metadata.defaultBranch)) {
      const proceed = await vscode.window.showWarningMessage(
        `${metadata.owner}/${metadata.repo}@${metadata.defaultBranch} is already configured.`,
        'Add with different branch',
        'Cancel',
      );
      if (proceed !== 'Add with different branch') return;
    }

    // Step 3: Pick branch
    const branch = await vscode.window.showInputBox({
      prompt: 'Branch to index',
      value: metadata.defaultBranch,
      ignoreFocusOut: true,
    });
    if (!branch) return;

    // Step 4: Include patterns
    const includeInput = await vscode.window.showInputBox({
      prompt: 'Include patterns (comma-separated globs, leave empty for all files)',
      placeHolder: 'e.g. src/**/*.ts, docs/**/*.md',
      ignoreFocusOut: true,
    });
    if (includeInput === undefined) return;
    const includePatterns = includeInput
      ? includeInput.split(',').map((p) => p.trim()).filter(Boolean)
      : [];

    // Step 5: Sync schedule
    const schedule = await vscode.window.showQuickPick(
      [
        { label: 'On Startup', value: 'onStartup' as const },
        { label: 'Daily', value: 'daily' as const },
        { label: 'Manual', value: 'manual' as const },
      ],
      { placeHolder: 'Sync schedule', ignoreFocusOut: true },
    );
    if (!schedule) return;

    // Step 6: Tool name
    const defaultToolName = `${metadata.owner}_${metadata.repo}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const toolName = await vscode.window.showInputBox({
      prompt: 'Tool name (alphanumeric and underscores only)',
      value: defaultToolName,
      validateInput: (v) =>
        /^[a-zA-Z0-9_]{1,64}$/.test(v) ? null : 'Alphanumeric and underscores only, max 64 chars',
      ignoreFocusOut: true,
    });
    if (!toolName) return;

    // Step 7: Tool description
    const defaultDescription = metadata.description
      ? `Search ${metadata.owner}/${metadata.repo}: ${metadata.description}`
      : `Search the ${metadata.owner}/${metadata.repo} codebase`;
    const toolDescription = await vscode.window.showInputBox({
      prompt: 'Tool description (helps Copilot decide when to use this tool)',
      value: defaultDescription,
      ignoreFocusOut: true,
    });
    if (!toolDescription) return;

    // Create data source
    const dsOptions: AddDataSourceOptions = {
      repoUrl: `https://github.com/${metadata.owner}/${metadata.repo}`,
      owner: metadata.owner,
      repo: metadata.repo,
      branch,
      includePatterns,
      excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
      syncSchedule: schedule.value,
    };
    const ds = await this.dataSourceManager.add(dsOptions);

    // Create tool
    const tool: ToolConfig = {
      id: crypto.randomUUID(),
      name: toolName,
      description: toolDescription,
      dataSourceIds: [ds.id],
    };
    this.configManager.addTool(tool);

    vscode.window.showInformationMessage(
      `Added ${metadata.owner}/${metadata.repo}. Indexing started.`,
    );
  }

  private async getRepoInput(): Promise<{ owner: string; repo: string } | undefined> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(link) Paste Repository URL', value: 'url' },
        { label: '$(search) Browse My Repositories', value: 'browse' },
      ],
      { placeHolder: 'How would you like to add a repository?' },
    );
    if (!choice) return undefined;

    if (choice.value === 'url') {
      const url = await vscode.window.showInputBox({
        prompt: 'GitHub repository URL',
        placeHolder: 'https://github.com/owner/repo',
        validateInput: (v) => {
          const result = parseRepoUrl(v);
          return isRepoUrlResult(result) ? null : result.error;
        },
        ignoreFocusOut: true,
      });
      if (!url) return undefined;
      const result = parseRepoUrl(url);
      return isRepoUrlResult(result) ? result : undefined;
    }

    // Browse repos
    const repos = await this.browser.listUserRepos();
    const picked = await vscode.window.showQuickPick(
      repos.map((r) => ({
        label: r.fullName,
        description: r.description ?? '',
        detail: r.private ? '$(lock) Private' : '$(globe) Public',
        repo: r,
      })),
      { placeHolder: 'Select a repository', ignoreFocusOut: true },
    );
    if (!picked) return undefined;
    return { owner: picked.repo.owner, repo: picked.repo.repo };
  }
}
