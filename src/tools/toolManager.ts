import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { ToolHandler } from './toolHandler';
import { ToolConfig } from '../config/configSchema';
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
    // Always register the global search tool
    this.registerGlobalSearchTool();

    // Register user-configured tools
    for (const tool of this.configManager.getTools()) {
      this.registerTool(tool);
    }
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

  private registerTool(tool: ToolConfig): void {
    if (this.registeredTools.has(tool.id)) return;

    const toolName = `repolens-${tool.name}`;
    const disposable = vscode.lm.registerTool(toolName, {
      invoke: async (options, token) => {
        return this.toolHandler.handle(
          tool.id,
          options as vscode.LanguageModelToolInvocationOptions<{ query: string }>,
          token,
        );
      },
    });

    this.registeredTools.set(tool.id, disposable);
    this.logger.info(`Registered tool: ${toolName}`);
  }

  private syncRegistrations(): void {
    const configToolIds = new Set(this.configManager.getTools().map((t) => t.id));

    // Remove tools no longer in config
    for (const [id, disposable] of this.registeredTools) {
      if (id !== '__global__' && !configToolIds.has(id)) {
        disposable.dispose();
        this.registeredTools.delete(id);
        this.logger.info(`Unregistered tool: ${id}`);
      }
    }

    // Register new tools
    for (const tool of this.configManager.getTools()) {
      if (!this.registeredTools.has(tool.id)) {
        this.registerTool(tool);
      }
    }
  }

  dispose(): void {
    for (const disposable of this.registeredTools.values()) {
      disposable.dispose();
    }
    this.registeredTools.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
