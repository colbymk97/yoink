import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import { AddRepoWizard } from '../../../src/ui/wizard/addRepoWizard';

describe('AddRepoWizard', () => {
  let resolver: any;
  let browser: any;
  let dataSourceManager: any;
  let configManager: any;
  let embeddingRegistry: any;

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
    };
    dataSourceManager = {
      add: vi.fn().mockResolvedValue({ id: 'ds-1' }),
      isDuplicate: vi.fn().mockReturnValue(false),
    };
    configManager = {
      addTool: vi.fn(),
      getDataSources: vi.fn().mockReturnValue([]),
    };
    embeddingRegistry = {
      hasApiKey: vi.fn().mockResolvedValue(true),
      setApiKey: vi.fn(),
      getProvider: vi.fn(),
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
    // Include patterns
    (vscode.window.showInputBox as any).mockResolvedValueOnce('src/**/*.ts');
    // Sync schedule
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'On Startup', value: 'onStartup',
    });
    // Tool name
    (vscode.window.showInputBox as any).mockResolvedValueOnce('acme_widgets');
    // Tool description
    (vscode.window.showInputBox as any).mockResolvedValueOnce(
      'Search acme/widgets',
    );
  }

  it('completes the full wizard flow', async () => {
    setupFullFlow();
    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, configManager, embeddingRegistry);

    await wizard.run();

    expect(resolver.resolve).toHaveBeenCalledWith('acme', 'widgets');
    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        branch: 'main',
        includePatterns: ['src/**/*.ts'],
        syncSchedule: 'onStartup',
      }),
    );
    expect(configManager.addTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'acme_widgets',
        description: 'Search acme/widgets',
        dataSourceIds: ['ds-1'],
      }),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('acme/widgets'),
    );
  });

  it('cancels when user dismisses URL input', async () => {
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Paste URL', value: 'url',
    });
    (vscode.window.showInputBox as any).mockResolvedValueOnce(undefined);

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, configManager, embeddingRegistry);
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

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, configManager, embeddingRegistry);
    await wizard.run();

    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('warns about duplicate and cancels when user chooses Cancel', async () => {
    dataSourceManager.isDuplicate.mockReturnValue(true);

    (vscode.window.showQuickPick as any).mockResolvedValueOnce({
      label: 'Paste URL', value: 'url',
    });
    (vscode.window.showInputBox as any).mockResolvedValueOnce(
      'https://github.com/acme/widgets',
    );
    (vscode.window.showWarningMessage as any).mockResolvedValueOnce('Cancel');

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, configManager, embeddingRegistry);
    await wizard.run();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('already configured'),
      'Add with different branch',
      'Cancel',
    );
    expect(dataSourceManager.add).not.toHaveBeenCalled();
  });

  it('browses repos when user chooses browse', async () => {
    browser.listUserRepos.mockResolvedValue([
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
      // sync schedule
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });

    // Branch, include, tool name, description
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('acme_widgets')
      .mockResolvedValueOnce('Search widgets');

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, configManager, embeddingRegistry);
    await wizard.run();

    expect(browser.listUserRepos).toHaveBeenCalled();
    expect(dataSourceManager.add).toHaveBeenCalled();
  });

  it('handles empty include patterns', async () => {
    setupFullFlow();
    // Override include patterns to be empty
    (vscode.window.showInputBox as any).mockReset();
    (vscode.window.showInputBox as any)
      .mockResolvedValueOnce('https://github.com/acme/widgets')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('') // empty include
      .mockResolvedValueOnce('acme_widgets')
      .mockResolvedValueOnce('Search acme/widgets');

    // Re-setup quickpick
    (vscode.window.showQuickPick as any).mockReset();
    (vscode.window.showQuickPick as any)
      .mockResolvedValueOnce({ label: 'Paste URL', value: 'url' })
      .mockResolvedValueOnce({ label: 'Manual', value: 'manual' });

    const wizard = new AddRepoWizard(resolver, browser, dataSourceManager, configManager, embeddingRegistry);
    await wizard.run();

    expect(dataSourceManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ includePatterns: [] }),
    );
  });
});
