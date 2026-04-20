import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track registrations
const registeredTools = new Map<string, any>();
const disposedTools: string[] = [];

vi.mock('vscode', () => ({
  lm: {
    registerTool: vi.fn().mockImplementation((name: string, handler: any) => {
      registeredTools.set(name, handler);
      return {
        dispose: () => {
          disposedTools.push(name);
          registeredTools.delete(name);
        },
      };
    }),
  },
}));

import { ToolManager } from '../../../src/tools/toolManager';

describe('ToolManager', () => {
  let toolHandler: any;
  let logger: any;

  beforeEach(() => {
    registeredTools.clear();
    disposedTools.length = 0;

    toolHandler = {
      handleGlobalSearch: vi.fn(),
      handleList: vi.fn(),
    };

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  it('registerAll registers both global search and list tools', () => {
    const manager = new ToolManager(toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('yoink-search')).toBe(true);
    expect(registeredTools.has('yoink-list')).toBe(true);
    manager.dispose();
  });

  it('does not duplicate global tool on repeated registerAll calls', () => {
    const manager = new ToolManager(toolHandler, logger);
    manager.registerAll();
    manager.registerAll();

    manager.dispose();
    const globalDisposals = disposedTools.filter((n) => n === 'yoink-search');
    expect(globalDisposals.length).toBe(1);
  });

  it('does not duplicate list tool on repeated registerAll calls', () => {
    const manager = new ToolManager(toolHandler, logger);
    manager.registerAll();
    manager.registerAll();

    manager.dispose();
    const listDisposals = disposedTools.filter((n) => n === 'yoink-list');
    expect(listDisposals.length).toBe(1);
  });

  it('global search tool invokes toolHandler.handleGlobalSearch', async () => {
    const manager = new ToolManager(toolHandler, logger);
    manager.registerAll();

    const handler = registeredTools.get('yoink-search');
    const mockOptions = { input: { query: 'test' } };
    const mockToken = { isCancellationRequested: false };

    await handler.invoke(mockOptions, mockToken);

    expect(toolHandler.handleGlobalSearch).toHaveBeenCalledWith(mockOptions, mockToken);
    manager.dispose();
  });

  it('list tool invokes toolHandler.handleList', async () => {
    const manager = new ToolManager(toolHandler, logger);
    manager.registerAll();

    const handler = registeredTools.get('yoink-list');
    const mockOptions = { input: {} };
    const mockToken = { isCancellationRequested: false };

    await handler.invoke(mockOptions, mockToken);

    expect(toolHandler.handleList).toHaveBeenCalledWith(mockToken);
    manager.dispose();
  });

  it('dispose cleans up all registered tools', () => {
    const manager = new ToolManager(toolHandler, logger);
    manager.registerAll();

    manager.dispose();

    expect(disposedTools).toContain('yoink-search');
    expect(disposedTools).toContain('yoink-list');
  });
});
