import * as vscode from 'vscode';
import { parseRepoUrl, isRepoUrlResult, GitHubResolver } from '../../sources/github/githubResolver';
import { RepoBrowser } from '../../sources/github/repoBrowser';
import { DataSourceManager, AddDataSourceOptions } from '../../sources/dataSourceManager';
import { DEFAULT_EXCLUDE_PATTERNS } from '../../config/configSchema';
import { REPO_TYPE_PRESETS } from '../../config/repoTypePresets';
import { EmbeddingManager } from '../../embedding/manager';

export class AddRepoWizard {
  constructor(
    private readonly resolver: GitHubResolver,
    private readonly browser: RepoBrowser,
    private readonly dataSourceManager: DataSourceManager,
    private readonly embeddingManager: EmbeddingManager,
  ) {}

  async run(): Promise<void> {
    // Step 0: Ensure embeddings are configured
    if (!(await this.embeddingManager.ensureConfigured())) {
      return;
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

    // Step 4: Select repo type
    const typeItems = Object.values(REPO_TYPE_PRESETS).map((p) => ({
      label: p.displayName,
      description: p.wizardDescription,
      preset: p,
    }));
    const typeChoice = await vscode.window.showQuickPick(typeItems, {
      placeHolder: 'What kind of repo is this?',
      ignoreFocusOut: true,
    });
    if (!typeChoice) return;
    const selectedPreset = typeChoice.preset;

    // Step 5: Include patterns (pre-populated from preset)
    const includeInput = await vscode.window.showInputBox({
      prompt: 'Include patterns (comma-separated globs, leave empty for all files)',
      placeHolder: 'e.g. src/**/*.ts, docs/**/*.md',
      value: selectedPreset.includePatterns.join(', '),
      ignoreFocusOut: true,
    });
    if (includeInput === undefined) return;
    const includePatterns = includeInput
      ? includeInput.split(',').map((p) => p.trim()).filter(Boolean)
      : [];

    // Step 6: Sync schedule
    const scheduleItems = [
      { label: 'Manual', value: 'manual' as const },
      { label: 'On Startup', value: 'onStartup' as const },
      { label: 'Daily', value: 'daily' as const },
    ];
    const schedule = await vscode.window.showQuickPick<(typeof scheduleItems)[number]>(scheduleItems, {
      placeHolder: 'Sync schedule',
      ignoreFocusOut: true,
    });
    if (!schedule) return;

    // Create data source
    const dsOptions: AddDataSourceOptions = {
      repoUrl: `https://github.com/${metadata.owner}/${metadata.repo}`,
      owner: metadata.owner,
      repo: metadata.repo,
      branch,
      type: selectedPreset.id,
      includePatterns,
      excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
      syncSchedule: schedule.value,
    };
    await this.dataSourceManager.add(dsOptions);

    vscode.window.showInformationMessage(
      `Added ${metadata.owner}/${metadata.repo}. Indexing started.`,
    );
  }

  private async getRepoInput(): Promise<{ owner: string; repo: string } | undefined> {
    const choice = await vscode.window.showQuickPick<{ label: string; value: 'url' | 'browse' }>(
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

    // Browse repos — fetch all pages so large orgs (600+ repos) are fully searchable
    const repos = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading repositories…' },
      () => this.browser.listAllUserRepos(),
    );
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
