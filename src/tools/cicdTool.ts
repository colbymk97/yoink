export const LIST_WORKFLOWS_TOOL = {
  name: 'yoink-list-workflows',
  displayName: 'Yoink: List Workflows',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repository: {
        type: 'string' as const,
        description: "Optional: filter to a specific indexed repository in 'owner/repo' format. Omit to list all.",
      },
    },
    required: [] as string[],
  },
};

export const LIST_ACTIONS_TOOL = {
  name: 'yoink-list-actions',
  displayName: 'Yoink: List Actions',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repository: {
        type: 'string' as const,
        description: "Optional: filter to a specific indexed repository in 'owner/repo' format. Omit to list all.",
      },
    },
    required: [] as string[],
  },
};
