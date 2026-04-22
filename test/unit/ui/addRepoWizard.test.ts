import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    withProgress: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
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

    resolver = {
      resolve: vi.fn().mockResolvedValue(metadata),
    };
    browser = {
      listUserRepos: vi.fn().mockResolvedValue([]),
      listAllUserRepos: vi.fn().mockResolvedValue([]),
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
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Paste URL', value: 'url',
    });
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
    // Sync schedule
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'On Startup', value: 'onStartup',
    });
  }

  it('completes the full wizard flow', async () => {
    setupFullFlow();
    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, embeddingManager);

    await wizard.run();

    expect(resolver.resolve).toHaveBeenCalledWith('acme', 'widgets');
    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        branch: 'main',
        type: 'general',
        includePatterns: ['src/**/*.ts'],
        syncSchedule: 'onStartup',
      }),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('acme/widgets'),
    );
  });

  it('pre-populates include patterns from the selected type preset', async () => {
    const actionsPresetItem = {
      label: 'GitHub Actions library',
      description: 'action.yml / action.yaml files — one chunk per action',
      preset: REPO_TYPE_PRESETS['github-actions-library'],
    };

    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({ label: 'Paste URL', value: 'url' })
      .mockResolvedValueOnce(actionsPresetItem)
      .mockResolvedValueOnce({ label: 'On Startup', value: 'onStartup' });
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/actions')
      .mockResolvedValueOnce('main')
      .mockImplementationOnce(async (opts: any) => opts.value); // accept pre-filled include value

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, embeddingManager);
    await wizard.run();

    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'github-actions-library',
        includePatterns: ['**/action.yml', '**/action.yaml', '**/README.md'],
      }),
    );
  });

  it('cancels when user dismisses URL input', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Paste URL', value: 'url',
    });
    (vscode.window.showInputBox as any).mockResolvedValueOnce(undefined);

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, embeddingManager);
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('cancels when user dismisses branch input', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Paste URL', value: 'url',
    });
    (vscode.window.showInputBox as any).mockResolvedValueOnce(
      'https://github.com/acme/widgets',
    );
    // Branch cancelled
    (vscode.window.showInputBox as any).mockResolvedValueOnce(undefined);

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, embeddingManager);
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('browses repos when user chooses browse', async () => {
    browser.listAllUserRepos.mockResolvedValue([
      { owner: 'acme', repo: 'widgets', fullName: 'acme/widgets', description: 'Desc', private: false },
    ]);

    // Step 1: choose browse
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({ label: 'Browse', value: 'browse' })
      // repo picker
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
      .mockResolvedValueOnce('');

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, embeddingManager);
    await wizard.run();

    expect(browser.listAllUserRepos).toHaveBeenCalled();
    expect(dataSourceManager.add).toHaveBeenCalled();
  });

  it('handles empty include patterns', async () => {
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({ label: 'Paste URL', value: 'url' })
      .mockResolvedValueOnce(generalPresetItem)
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });

    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/widgets')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce(''); // empty include

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, embeddingManager);
    await wizard.run();

    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ includePatterns: [] }),
    );
  });
});
