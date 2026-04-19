import * as vscode from 'vscode';
import { ToolHandler } from './toolHandler';
import { GET_FILE_TOOL } from './getFileTool';
import { LIST_WORKFLOWS_TOOL, LIST_ACTIONS_TOOL } from './cicdTool';
import { FILE_TREE_TOOL } from './fileTreeTool';
import { Logger } from '../util/logger';
import { ConfigManager } from '../config/configManager';

export class ToolManager implements vscode.Disposable {
  private readonly registeredTools = new Map<string, vscode.Disposable>();

  constructor(
    private readonly toolHandler: ToolHandler,
    private readonly logger: Logger,
    private readonly configManager: ConfigManager,
  ) {}

  private registrationName(name: string): string {
    return name;
  }

  registerAll(): void {
    this.registerGlobalSearchTool();
    this.registerListTool();
    this.registerGetFileTool();
    this.registerListWorkflowsTool();
    this.registerListActionsTool();
    this.registerFileTreeTool();
    this.syncRegistrations();
  }

  private registerGlobalSearchTool(): void {
    if (this.registeredTools.has('__global__')) return;

    const disposable = vscode.lm.registerTool('yoink-search', {
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

    const disposable = vscode.lm.registerTool('yoink-list', {
      invoke: async (_options, token) => {
        return this.toolHandler.handleList(token);
      },
    });

    this.registeredTools.set('__list__', disposable);
    this.logger.info('Registered list tool');
  }
  private registerGetFileTool(): void {
    if (this.registeredTools.has('__getfile__')) return;

    const disposable = vscode.lm.registerTool(GET_FILE_TOOL.name, {
      invoke: async (options, token) => {
        return this.toolHandler.handleGetFile(
          options as vscode.LanguageModelToolInvocationOptions<{
            repository: string;
            filePath: string;
            startLine?: number;
            endLine?: number;
          }>,
          token,
        );
      },
    });

    this.registeredTools.set('__getfile__', disposable);
    this.logger.info('Registered get file tool');
  }

  private registerListWorkflowsTool(): void {
    if (this.registeredTools.has('__list-workflows__')) return;

    const disposable = vscode.lm.registerTool(LIST_WORKFLOWS_TOOL.name, {
      invoke: async (options, token) => {
        return this.toolHandler.handleListWorkflows(
          options as vscode.LanguageModelToolInvocationOptions<{ repository?: string }>,
          token,
        );
      },
    });

    this.registeredTools.set('__list-workflows__', disposable);
    this.logger.info('Registered list-workflows tool');
  }

  private registerListActionsTool(): void {
    if (this.registeredTools.has('__list-actions__')) return;

    const disposable = vscode.lm.registerTool(LIST_ACTIONS_TOOL.name, {
      invoke: async (options, token) => {
        return this.toolHandler.handleListActions(
          options as vscode.LanguageModelToolInvocationOptions<{ repository?: string }>,
          token,
        );
      },
    });

    this.registeredTools.set('__list-actions__', disposable);
    this.logger.info('Registered list-actions tool');
  }

  private registerFileTreeTool(): void {
    if (this.registeredTools.has('__file-tree__')) return;

    const disposable = vscode.lm.registerTool(FILE_TREE_TOOL.name, {
      invoke: async (options, token) => {
        return this.toolHandler.handleFileTree(
          options as vscode.LanguageModelToolInvocationOptions<{
            repository: string;
            path?: string;
            maxDepth?: number;
            include?: string[];
            exclude?: string[];
            page?: number;
            pageSize?: number;
          }>,
          token,
        );
      },
    });

    this.registeredTools.set('__file-tree__', disposable);
    this.logger.info('Registered file-tree tool');
  }

  private syncRegistrations(): void {
    const configTools = this.configManager.getTools();
    const desiredNames = new Set(
      configTools.map((t) => this.registrationName(t.name)),
    );
    const reserved = new Set(['__global__', '__getfile__', '__list__', '__list-workflows__', '__list-actions__', '__file-tree__']);

    // Unregister tools no longer in config
    for (const [key, disposable] of this.registeredTools) {
      if (reserved.has(key)) continue;
      if (!desiredNames.has(key)) {
        disposable.dispose();
        this.registeredTools.delete(key);
        this.logger.info(`Unregistered tool: ${key}`);
      }
    }
  }

  dispose(): void {
    for (const disposable of this.registeredTools.values()) {
      disposable.dispose();
    }
    this.registeredTools.clear();
  }
}
