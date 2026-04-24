import { describe, it, expect, vi, beforeEach } from 'vitest';

const quickPickState = vi.hoisted(() => ({
  drivers: [] as Array<(quickPick: any) => void>,
}));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    withProgress: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
    createQuickPick: vi.fn().mockImplementation(() => {
      let onDidChangeValue: ((value: string) => void) | undefined;
      let onDidAccept: (() => void) | undefined;
      let onDidHide: (() => void) | undefined;
      const quickPick: any = {
        value: '',
        placeholder: undefined,
        matchOnDescription: false,
        items: [],
        activeItems: [],
        selectedItems: [],
        onDidChangeValue: vi.fn().mockImplementation((cb: (value: string) => void) => {
          onDidChangeValue = cb;
          return { dispose: vi.fn() };
        }),
        onDidAccept: vi.fn().mockImplementation((cb: () => void) => {
          onDidAccept = cb;
          return { dispose: vi.fn() };
        }),
        onDidHide: vi.fn().mockImplementation((cb: () => void) => {
          onDidHide = cb;
          return { dispose: vi.fn() };
        }),
        show: vi.fn().mockImplementation(() => {
          const driver = quickPickState.drivers.shift();
          driver?.(quickPick);
        }),
        dispose: vi.fn(),
        _changeValue: (value: string) => {
          quickPick.value = value;
          onDidChangeValue?.(value);
        },
        _accept: (item?: any) => {
          if (item) {
            quickPick.selectedItems = [item];
            quickPick.activeItems = [item];
          }
          onDidAccept?.();
        },
        _hide: () => onDidHide?.(),
      };
      return quickPick;
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
    }),
  },
  ProgressLocation: { Notification: 15 },
}));

import * as vscode from 'vscode';
import { AddRepoWizard } from '../../../src/ui/wizard/addRepoWizard';
import { REPO_TYPE_PRESETS } from '../../../src/config/repoTypePresets';

const generalPresetItem = {
  label: 'General codebase',
  description: 'Index all source files with default filters',
  preset: REPO_TYPE_PRESETS.general,
};

describe('AddRepoWizard', () => {
  let resolver: any;
  let browser: any;
  let fetcher: any;
  let dataSourceManager: any;
  let embeddingManager: any;

  const metadata = {
    owner: 'acme',
    repo: 'widgets',
    defaultBranch: 'main',
    description: 'A widget library',
    private: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    quickPickState.drivers = [];

    resolver = {
      resolve: vi.fn().mockResolvedValue(metadata),
    };
    browser = {
      listUserRepos: vi.fn().mockResolvedValue([]),
      listAllUserRepos: vi.fn().mockResolvedValue([]),
      hasFreshUserRepoCache: vi.fn().mockReturnValue(false),
    };
    fetcher = {
      getBranchSha: vi.fn().mockResolvedValue('sha-main'),
      getTree: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    };
    dataSourceManager = {
      add: vi.fn().mockResolvedValue({ id: 'ds-1' }),
      isDuplicate: vi.fn().mockReturnValue(false),
    };
    embeddingManager = {
      ensureConfigured: vi.fn().mockResolvedValue(true),
    };
  });

  function setupFullFlow() {
    // Step 1: Choose URL input
    queueRepoInputChoice('url');
    // URL input
    (vscode.window.showInputBox as any).mockResolvedValueOnce(
      'https://github.com/acme/widgets',
    );
    // Branch
    (vscode.window.showInputBox as any).mockResolvedValueOnce('main');
    // Type selection
    (vscode.window.showQuickPick as any).mockResolvedValueOnce(generalPresetItem);
    // Include patterns
    (vscode.window.showInputBox as any).mockResolvedValueOnce('src/**/*.ts');
    // Additional exclude patterns
    (vscode.window.showInputBox as any).mockResolvedValueOnce('examples/**, **/*.generated.ts');
    // Sync schedule
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'On Startup', value: 'onStartup',
    });
  }

  function queueRepoInputChoice(value: 'url' | 'browse') {
    quickPickState.drivers.push((quickPick) => {
      const choice = quickPick.items.find((item: any) => item.value === value);
      quickPick._accept(choice);
    });
  }

  function queueTypedRepoInput(value: string, acceptUseUrl = true) {
    quickPickState.drivers.push((quickPick) => {
      quickPick._changeValue(value);
      if (acceptUseUrl) {
        const choice = quickPick.items.find((item: any) => item.value === 'direct-url');
        quickPick._accept(choice);
      }
    });
  }

  function makeWizard() {
    return new AddRepoWizard(resolver, browser, fetcher, dataSourceManager, embeddingManager);
  }

  it('completes the full wizard flow', async () => {
    setupFullFlow();
    const wizard = makeWizard();

    await wizard.run();

    expect(resolver.resolve).toHaveBeenCalledWith('acme', 'widgets');
    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        branch: 'main',
        type: 'general',
        description: 'A widget library',
        includePatterns: ['src/**/*.ts'],
        excludePatterns: ['examples/**', '**/*.generated.ts'],
        syncSchedule: 'onStartup',
      }),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('acme/widgets'),
    );
  });

  it('accepts a pasted URL in the first wizard step', async () => {
    queueTypedRepoInput('https://github.com/acme/widgets');
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('src/**/*.ts')
      .mockResolvedValueOnce('');
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce(generalPresetItem)
      .mockResolvedValueOnce({ label: 'On Startup', value: 'onStartup' });

    const wizard = makeWizard();
    await wizard.run();

    expect(resolver.resolve).toHaveBeenCalledWith('acme', 'widgets');
    expect(vscode.window.showInputBox).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'GitHub repository URL' }),
    );
    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
      }),
    );
  });

  it('does not offer a direct URL choice for invalid typed text', async () => {
    quickPickState.drivers.push((quickPick) => {
      quickPick._changeValue('not a url');
      expect(quickPick.items.some((item: any) => item.value === 'direct-url')).toBe(false);
      quickPick._hide();
    });

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('cancels when the first repository input quick pick is dismissed', async () => {
    quickPickState.drivers.push((quickPick) => quickPick._hide());

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('pre-populates include patterns from the selected type preset', async () => {
    const actionsPresetItem = {
      label: 'GitHub Actions library',
      description: 'action.yml / action.yaml files — one chunk per action',
      preset: REPO_TYPE_PRESETS['github-actions-library'],
    };

    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce(actionsPresetItem)
      .mockResolvedValueOnce({ label: 'On Startup', value: 'onStartup' });
    queueRepoInputChoice('url');
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/actions')
      .mockResolvedValueOnce('main')
      .mockImplementationOnce(async (opts: any) => opts.value) // accept pre-filled include value
      .mockResolvedValueOnce('');

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'github-actions-library',
        includePatterns: ['**/action.yml', '**/action.yaml', '**/README.md'],
        excludePatterns: [],
      }),
    );
  });

  it('cancels when user dismisses URL input', async () => {
    queueRepoInputChoice('url');
    (vscode.window.showInputBox as any).mockResolvedValueOnce(undefined);

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('cancels when user dismisses branch input', async () => {
    queueRepoInputChoice('url');
    (vscode.window.showInputBox as any).mockResolvedValueOnce(
      'https://github.com/acme/widgets',
    );
    // Branch cancelled
    (vscode.window.showInputBox as any).mockResolvedValueOnce(undefined);

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('browses repos when user chooses browse', async () => {
    browser.listAllUserRepos.mockResolvedValue([
      { owner: 'acme', repo: 'widgets', fullName: 'acme/widgets', description: 'Desc', private: false },
    ]);

    // Step 1: choose browse
    queueRepoInputChoice('browse');
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({
        label: 'acme/widgets',
        repo: { owner: 'acme', repo: 'widgets' },
      })
      // type selection
      .mockResolvedValueOnce(generalPresetItem)
      // sync schedule
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });

    // Branch, include
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('fixtures/**');

    const wizard = makeWizard();
    await wizard.run();

    expect(browser.listAllUserRepos).toHaveBeenCalled();
    expect(dataSourceManager.add).toHaveBeenCalled();
  });

  it('can refresh the cached repository list while browsing repos', async () => {
    browser.listAllUserRepos
      .mockResolvedValueOnce([
        { owner: 'old', repo: 'repo', fullName: 'old/repo', description: null, private: false },
      ])
      .mockResolvedValueOnce([
        { owner: 'acme', repo: 'widgets', fullName: 'acme/widgets', description: 'Desc', private: false },
      ]);

    queueRepoInputChoice('browse');
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({ label: '$(refresh) Refresh repository list', value: 'refresh' })
      .mockResolvedValueOnce({
        label: 'acme/widgets',
        value: 'repo',
        repo: { owner: 'acme', repo: 'widgets' },
      })
      .mockResolvedValueOnce(generalPresetItem)
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const wizard = makeWizard();
    await wizard.run();

    expect(browser.listAllUserRepos).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(browser.listAllUserRepos).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widgets' }),
    );
  });

  it('handles empty include patterns', async () => {
    queueRepoInputChoice('url');
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce(generalPresetItem)
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });

    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/widgets')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('') // empty include
      .mockResolvedValueOnce('examples/**, vendor/**'); // custom excludes

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        includePatterns: [],
        excludePatterns: ['examples/**', 'vendor/**'],
      }),
    );
  });

  it('stores empty exclude patterns as an empty array', async () => {
    queueRepoInputChoice('url');
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce(generalPresetItem)
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });

    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/widgets')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('src/**/*.ts')
      .mockResolvedValueOnce('');

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ excludePatterns: [] }),
    );
  });

  it('warns before adding a large data source and continues when accepted', async () => {
    queueRepoInputChoice('url');
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce(generalPresetItem)
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/widgets')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    fetcher.getTree.mockResolvedValue({
      entries: Array.from({ length: 1000 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        sha: `sha-${i}`,
        size: 100,
        type: 'blob',
      })),
      truncated: false,
    });
    (vscode.window.showWarningMessage as any).mockResolvedValueOnce('Continue');

    const wizard = makeWizard();
    await wizard.run();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('may take a while to index'),
      { modal: true },
      'Continue',
      'Cancel',
    );
    expect(dataSourceManager.add).toHaveBeenCalled();
  });

  it('cancels when the large data source warning is declined', async () => {
    queueRepoInputChoice('url');
    (vscode.window.showQuickPick as any).mockResolvedValueOnce(generalPresetItem);
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/widgets')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    fetcher.getTree.mockResolvedValue({
      entries: Array.from({ length: 1000 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        sha: `sha-${i}`,
        size: 100,
        type: 'blob',
      })),
      truncated: false,
    });
    (vscode.window.showWarningMessage as any).mockResolvedValueOnce('Cancel');

    const wizard = makeWizard();
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });
});
