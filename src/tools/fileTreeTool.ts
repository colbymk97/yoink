export const FILE_TREE_TOOL = {
  name: 'yoink-file-tree',
  displayName: 'Yoink: File Tree',
  description:
    'Return a deterministic directory/file hierarchy for an indexed repository. ' +
    'Use this to orient yourself before diving into code — see what files exist, ' +
    'where they live, and which are tests, config, docs, or workflows. ' +
    'Faster and more complete than inferring structure from search results. ' +
    'Supports subtree focus, depth limiting, glob filtering, and pagination for large repos.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repository: {
        type: 'string' as const,
        description: "Indexed repository in 'owner/repo' format (e.g. 'vercel/next.js').",
      },
      path: {
        type: 'string' as const,
        description: "Subtree root to show (default: repo root). E.g. 'src/' to scope to src.",
      },
      maxDepth: {
        type: 'number' as const,
        description: 'Max directory depth to expand (default 5, max 10). Use a lower value for a high-level overview.',
      },
      include: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Glob patterns to include (e.g. ["**/*.ts"]). Applied to full file paths.',
      },
      exclude: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Glob patterns to exclude. Applied to full file paths.',
      },
      page: {
        type: 'number' as const,
        description: '1-indexed page number (default 1).',
      },
      pageSize: {
        type: 'number' as const,
        description: 'Lines per page (default 200, max 500).',
      },
    },
    required: ['repository'],
  },
};
