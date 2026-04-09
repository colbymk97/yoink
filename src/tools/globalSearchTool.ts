// Global search tool metadata.
// Registration is handled by ToolManager. This module defines the
// tool description used for Copilot discovery.

export const GLOBAL_SEARCH_TOOL = {
  name: 'repolens-search',
  displayName: 'RepoLens Search',
  description:
    'Search across all configured repository knowledge bases. ' +
    'Use this to find code, documentation, patterns, or examples ' +
    'from any indexed GitHub repository.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'The search query to find relevant code or documentation',
      },
      tool: {
        type: 'string' as const,
        description:
          'Optional: use a configured RepoLens tool name to search only its assigned repositories.',
      },
    },
    required: ['query'],
  },
};

export const LIST_TOOL = {
  name: 'repolens-list',
  displayName: 'RepoLens List',
  description:
    'List all indexed data sources and configured tools in RepoLens.',
};
