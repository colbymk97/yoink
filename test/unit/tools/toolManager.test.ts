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
import { ToolConfig } from '../../../src/config/configSchema';

function makeTool(id: string, name: string): ToolConfig {
  return { id, name, description: 'Test tool', dataSourceIds: ['ds-1'] };
}

describe('ToolManager', () => {
  let changeListeners: Array<() => void>;
  let configTools: ToolConfig[];
  let configManager: any;
  let toolHandler: any;
  let logger: any;

  beforeEach(() => {
    registeredTools.clear();
    disposedTools.length = 0;
    changeListeners = [];
    configTools = [];

    configManager = {
      getTools: () => configTools,
      onDidChange: (cb: () => void) => {
        changeListeners.push(cb);
        return { dispose: vi.fn() };
      },
    };

    toolHandler = {
      handle: vi.fn(),
      handleGlobalSearch: vi.fn(),
    };

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  it('registerAll registers the global search tool', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-search')).toBe(true);
    manager.dispose();
  });

  it('registerAll registers user-configured tools', () => {
    configTools = [makeTool('t-1', 'my-tool'), makeTool('t-2', 'other-tool')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-my-tool')).toBe(true);
    expect(registeredTools.has('repolens-other-tool')).toBe(true);
    manager.dispose();
  });

  it('does not duplicate global tool on repeated registerAll calls', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();
    manager.registerAll();

    // Only registered once — if it were duplicated, dispose would show 2 entries
    manager.dispose();
    const globalDisposals = disposedTools.filter((n) => n === 'repolens-search');
    expect(globalDisposals.length).toBe(1);
  });

  it('syncRegistrations adds new tools from config', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-new-tool')).toBe(false);

    // Simulate config change — add a new tool
    configTools = [makeTool('t-new', 'new-tool')];
    changeListeners.forEach((cb) => cb());

    expect(registeredTools.has('repolens-new-tool')).toBe(true);
    manager.dispose();
  });

  it('syncRegistrations removes tools no longer in config', () => {
    configTools = [makeTool('t-1', 'old-tool')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-old-tool')).toBe(true);

    // Remove the tool from config and trigger sync
    configTools = [];
    changeListeners.forEach((cb) => cb());

    expect(disposedTools).toContain('repolens-old-tool');
    manager.dispose();
  });

  it('dispose cleans up all registered tools', () => {
    configTools = [makeTool('t-1', 'tool-a')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    manager.dispose();

    expect(disposedTools).toContain('repolens-search');
    expect(disposedTools).toContain('repolens-tool-a');
  });

  it('keeps global tool during syncRegistrations', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    // Trigger sync with empty config
    configTools = [];
    changeListeners.forEach((cb) => cb());

    // Global tool should still be registered
    expect(registeredTools.has('repolens-search')).toBe(true);
    expect(disposedTools).not.toContain('repolens-search');
    manager.dispose();
  });
});
