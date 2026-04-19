// Get File tool metadata.
// Registration is handled by ToolManager. This module defines the
// tool description used for Copilot discovery.

export const GET_FILE_TOOL = {
  name: 'yoink-get-file',
  displayName: 'Yoink: Get File',
  description:
    'Fetch the complete content of a text file from an indexed GitHub repository. ' +
    'Always returns the full file in one call — no pagination needed. ' +
    'Fails for binary files or files over 500 KB. ' +
    'Use startLine and endLine only to focus on a specific section when you already know the range.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repository: {
        type: 'string' as const,
        description:
          "The indexed repository in 'owner/repo' format (e.g. 'vercel/next.js'). " +
          'Use the repository shown in search results.',
      },
      filePath: {
        type: 'string' as const,
        description: 'Path to the file within the repository, as shown in search results.',
      },
      startLine: {
        type: 'number' as const,
        description: 'Optional. First line to return (1-indexed). Use line numbers from search results.',
      },
      endLine: {
        type: 'number' as const,
        description: 'Optional. Last line to return (1-indexed). Use line numbers from search results.',
      },
    },
    required: ['repository', 'filePath'],
  },
};
