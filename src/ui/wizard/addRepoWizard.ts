import * as vscode from 'vscode';
import { parseRepoUrl, isRepoUrlResult, GitHubResolver } from '../../sources/github/githubResolver';
import { RepoBrowser, RepoSearchResult } from '../../sources/github/repoBrowser';
import { GitHubFetcher, filterEligibleEntries } from '../../sources/github/githubFetcher';
import { DataSourceManager, AddDataSourceOptions } from '../../sources/dataSourceManager';
import { DEFAULT_EXCLUDE_PATTERNS } from '../../config/configSchema';
import { REPO_TYPE_PRESETS } from '../../config/repoTypePresets';
import { EmbeddingManager } from '../../embedding/manager';
import { parseCommaSeparatedPatterns } from '../patternInput';
import { FileFilter } from '../../ingestion/fileFilter';
import { SETTING_KEYS } from '../../config/settingsSchema';
import { formatCost, getPricingForModel } from '../../embedding/pricing';

const LARGE_INDEX_FILE_COUNT_WARNING = 1_000;
const LARGE_INDEX_BYTE_WARNING = 10_000_000;
const LARGE_INDEX_TOKEN_WARNING = 500_000;

type RepoInputChoice =
  | (vscode.QuickPickItem & { value: 'url' | 'browse' })
  | (vscode.QuickPickItem & {
      value: 'direct-url';
      parsed: { owner: string; repo: string };
    });

export class AddRepoWizard {
  constructor(
    private readonly resolver: GitHubResolver,
    private readonly browser: RepoBrowser,
    private readonly fetcher: GitHubFetcher,
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
    const includePatterns = parseCommaSeparatedPatterns(includeInput);

    // Step 6: Additional exclude patterns
    const excludeInput = await vscode.window.showInputBox({
      prompt: `Additional exclude patterns (comma-separated globs). Built-in excludes always apply: ${DEFAULT_EXCLUDE_PATTERNS.join(', ')}`,
      placeHolder: 'examples/**, vendor/**, **/*.generated.ts',
      value: '',
      ignoreFocusOut: true,
    });
    if (excludeInput === undefined) return;
    const excludePatterns = parseCommaSeparatedPatterns(excludeInput);

    if (!(await this.confirmLargeIndex(metadata.owner, metadata.repo, branch, includePatterns, excludePatterns))) {
      return;
    }

    // Step 7: Sync schedule
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
      description: metadata.description ?? undefined,
      includePatterns,
      excludePatterns,
      syncSchedule: schedule.value,
    };
    await this.dataSourceManager.add(dsOptions);

    vscode.window.showInformationMessage(
      `Added ${metadata.owner}/${metadata.repo}. Indexing started.`,
    );
  }

  private async getRepoInput(): Promise<{ owner: string; repo: string } | undefined> {
    const choice = await this.pickRepoInputChoice();
    if (!choice) return undefined;

    if (choice.value === 'direct-url') {
      return choice.parsed;
    }

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

    const picked = await this.pickBrowsedRepository();
    if (!picked) return undefined;
    return { owner: picked.owner, repo: picked.repo };
  }

  private async pickBrowsedRepository(): Promise<{ owner: string; repo: string } | undefined> {
    let forceRefresh = false;
    while (true) {
      const repos = await this.loadUserRepositories(forceRefresh);
      forceRefresh = false;
      const refreshItem = {
        label: '$(refresh) Refresh repository list',
        description: this.browser.hasFreshUserRepoCache()
          ? 'Reload from GitHub'
          : 'Loaded from GitHub',
        value: 'refresh' as const,
      };
      const repoItems = repos.map((repo) => ({
        label: repo.fullName,
        description: repo.description ?? '',
        detail: repo.private ? '$(lock) Private' : '$(globe) Public',
        value: 'repo' as const,
        repo,
      }));
      const picked = await vscode.window.showQuickPick(
        [refreshItem, ...repoItems],
        { placeHolder: 'Select a repository', ignoreFocusOut: true },
      );
      if (!picked) return undefined;
      if (picked.value === 'refresh') {
        forceRefresh = true;
        continue;
      }
      return picked.repo;
    }
  }

  private async loadUserRepositories(forceRefresh: boolean): Promise<RepoSearchResult[]> {
    if (!forceRefresh && this.browser.hasFreshUserRepoCache()) {
      return this.browser.listAllUserRepos();
    }

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading repositories...' },
      () => this.browser.listAllUserRepos({ forceRefresh }),
    );
  }

  private pickRepoInputChoice(): Promise<RepoInputChoice | undefined> {
    const pasteUrlChoice: RepoInputChoice = {
      label: '$(link) Paste Repository URL',
      value: 'url',
    };
    const browseChoice: RepoInputChoice = {
      label: '$(search) Browse My Repositories',
      value: 'browse',
    };
    const defaultChoices = [pasteUrlChoice, browseChoice];

    return new Promise((resolve) => {
      const quickPick = vscode.window.createQuickPick<RepoInputChoice>();
      let settled = false;

      const settle = (choice: RepoInputChoice | undefined) => {
        if (settled) return;
        settled = true;
        quickPick.dispose();
        resolve(choice);
      };

      const updateItems = (value: string) => {
        const trimmed = value.trim();
        const result = parseRepoUrl(trimmed);
        if (isRepoUrlResult(result)) {
          const directChoice: RepoInputChoice = {
            label: `$(link) Use ${trimmed}`,
            description: `${result.owner}/${result.repo}`,
            value: 'direct-url',
            parsed: result,
          };
          quickPick.items = [directChoice, ...defaultChoices];
          quickPick.activeItems = [directChoice];
          return;
        }

        quickPick.items = defaultChoices;
        quickPick.activeItems = [];
        quickPick.selectedItems = [];
      };

      quickPick.placeholder = 'How would you like to add a repository? Paste a GitHub URL or choose an option.';
      quickPick.matchOnDescription = true;
      quickPick.items = defaultChoices;
      quickPick.onDidChangeValue(updateItems);
      quickPick.onDidAccept(() => {
        const choice = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        settle(choice);
      });
      quickPick.onDidHide(() => settle(undefined));
      quickPick.show();
    });
  }

  private async confirmLargeIndex(
    owner: string,
    repo: string,
    branch: string,
    includePatterns: string[],
    excludePatterns: string[],
  ): Promise<boolean> {
    const sha = await this.fetcher.getBranchSha(owner, repo, branch);
    const { entries } = await this.fetcher.getTree(owner, repo, sha);
    const filter = new FileFilter(
      includePatterns,
      [...excludePatterns, ...DEFAULT_EXCLUDE_PATTERNS],
    );
    const filteredEntries = entries.filter((entry) => filter.matches(entry.path));
    const eligibleEntries = filterEligibleEntries(filteredEntries);
    const totalBytes = eligibleEntries.reduce((sum, entry) => sum + entry.size, 0);
    const estimatedTokens = Math.ceil(totalBytes / 4);

    if (
      eligibleEntries.length < LARGE_INDEX_FILE_COUNT_WARNING &&
      totalBytes < LARGE_INDEX_BYTE_WARNING &&
      estimatedTokens < LARGE_INDEX_TOKEN_WARNING
    ) {
      return true;
    }

    const model = vscode.workspace.getConfiguration().get<string>(
      SETTING_KEYS.OPENAI_MODEL,
      'text-embedding-3-small',
    );
    const estimatedCost = formatCost(estimatedTokens, getPricingForModel(model).costPerToken);
    const costText = estimatedCost ? ` Estimated embedding cost: ${estimatedCost}.` : '';
    const choice = await vscode.window.showWarningMessage(
      `${owner}/${repo} may take a while to index: ${formatNumber(eligibleEntries.length)} files, ` +
      `${formatBytes(totalBytes)}, about ${formatNumber(estimatedTokens)} tokens.${costText}`,
      { modal: true },
      'Continue',
      'Cancel',
    );

    return choice === 'Continue';
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatBytes(value: number): string {
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)} KB`;
  }
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
