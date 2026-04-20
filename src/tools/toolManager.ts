import * as vscode from 'vscode';
import { ToolHandler } from './toolHandler';
import { GET_FILES_TOOL } from './getFileTool';
import { LIST_WORKFLOWS_TOOL, LIST_ACTIONS_TOOL } from './cicdTool';
import { FILE_TREE_TOOL } from './fileTreeTool';
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
    this.registerGetFilesTool();
    this.registerListWorkflowsTool();
    this.registerListActionsTool();
    this.registerFileTreeTool();
  }

  private registerGlobalSearchTool(): void {
    if (this.registeredTools.has('__global__')) return;

    const disposable = vscode.lm.registerTool('yoink-search', {
      invoke: async (options, token) => {
        return this.toolHandler.handleGlobalSearch(
          options as vscode.LanguageModelToolInvocationOptions<{ query: string; repository?: string }>,
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
  private registerGetFilesTool(): void {
    if (this.registeredTools.has('__getfiles__')) return;

    const disposable = vscode.lm.registerTool(GET_FILES_TOOL.name, {
      invoke: async (options, token) => {
        return this.toolHandler.handleGetFiles(
          options as vscode.LanguageModelToolInvocationOptions<{
            files: Array<{
              repository: string;
              filePath: string;
              startLine?: number;
              endLine?: number;
            }>;
          }>,
          token,
        );
      },
    });

    this.registeredTools.set('__getfiles__', disposable);
    this.logger.info('Registered get-files tool');
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

  dispose(): void {
    for (const disposable of this.registeredTools.values()) {
      disposable.dispose();
    }
    this.registeredTools.clear();
  }
}
