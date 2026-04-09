import * as vscode from 'vscode';
import { ToolHandler } from './toolHandler';
import { Logger } from '../util/logger';

export class ToolManager implements vscode.Disposable {
  private readonly registeredTools = new Map<string, vscode.Disposable>();

  constructor(
    private readonly toolHandler: ToolHandler,
    private readonly logger: Logger,
  ) {}

  registerAll(): void {
    this.registerGlobalSearchTool();
    this.registerListTool();
  }

  private registerGlobalSearchTool(): void {
    if (this.registeredTools.has('__global__')) return;

    const disposable = vscode.lm.registerTool('repolens-search', {
      invoke: async (options, token) => {
        return this.toolHandler.handleGlobalSearch(
          options as vscode.LanguageModelToolInvocationOptions<{ query: string; repository?: string; tool?: string }>,
          token,
        );
      },
    });

    this.registeredTools.set('__global__', disposable);
    this.logger.info('Registered global search tool');
  }

  private registerListTool(): void {
    if (this.registeredTools.has('__list__')) return;

    const disposable = vscode.lm.registerTool('repolens-list', {
      invoke: async (_options, token) => {
        return this.toolHandler.handleList(token);
      },
    });

    this.registeredTools.set('__list__', disposable);
    this.logger.info('Registered list tool');
  }

  dispose(): void {
    for (const disposable of this.registeredTools.values()) {
      disposable.dispose();
    }
    this.registeredTools.clear();
  }
}
