import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { ToolHandler } from './toolHandler';
import { Logger } from '../util/logger';

export class ToolManager implements vscode.Disposable {
  private readonly registeredTools = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly toolHandler: ToolHandler,
    private readonly logger: Logger,
  ) {
    // Re-sync tool registrations when config changes
    this.disposables.push(
      configManager.onDidChange(() => this.syncRegistrations()),
    );
  }

  registerAll(): void {
    this.registerGlobalSearchTool();
  }

  private registerGlobalSearchTool(): void {
    if (this.registeredTools.has('__global__')) return;

    const disposable = vscode.lm.registerTool('repolens-search', {
      invoke: async (options, token) => {
        return this.toolHandler.handleGlobalSearch(
          options as vscode.LanguageModelToolInvocationOptions<{ query: string }>,
          token,
        );
      },
    });

    this.registeredTools.set('__global__', disposable);
    this.logger.info('Registered global search tool');
  }

  private syncRegistrations(): void {
    // No-op: only the static global search tool is registered
  }

  dispose(): void {
    for (const disposable of this.registeredTools.values()) {
      disposable.dispose();
    }
    this.registeredTools.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
