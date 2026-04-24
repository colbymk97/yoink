// Repo type preset registry.
// Each type carries default include patterns and a tool description template.
// Chunking strategy is chosen per-file inside the chunker (see
// `Chunker.routeStrategy`); presets only decide which files get indexed.

export type DataSourceType =
  | 'general'
  | 'documentation'
  | 'source-code'
  | 'github-actions-library'
  | 'cicd-workflows'
  | 'openapi-specs';

export interface RepoTypePreset {
  id: DataSourceType;
  displayName: string;
  wizardDescription: string;
  includePatterns: string[];
  toolDescriptionTemplate: (owner: string, repo: string) => string;
}

export const REPO_TYPE_PRESETS: Record<DataSourceType, RepoTypePreset> = {
  general: {
    id: 'general',
    displayName: 'General codebase',
    wizardDescription: 'Index all files with default filters',
    includePatterns: [],
    toolDescriptionTemplate: (o, r) => `Search the ${o}/${r} codebase`,
  },
  documentation: {
    id: 'documentation',
    displayName: 'Documentation / standards',
    wizardDescription: 'Markdown and docs files — chunks split on headings',
    includePatterns: ['**/*.md', '**/*.mdx', 'docs/**', 'wiki/**'],
    toolDescriptionTemplate: (o, r) => `Search ${o}/${r} documentation and standards`,
  },
  'source-code': {
    id: 'source-code',
    displayName: 'Source code repository',
    wizardDescription:
      'Code files plus inline docs — functions/classes chunked via Tree-sitter, markdown split on headings',
    includePatterns: [
      '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,cs,rs,rb,md,mdx}',
    ],
    toolDescriptionTemplate: (o, r) =>
      `Search the ${o}/${r} codebase for functions, methods, classes, and docs`,
  },
  'github-actions-library': {
    id: 'github-actions-library',
    displayName: 'GitHub Actions library',
    wizardDescription: 'action.yml / action.yaml files — one chunk per action',
    includePatterns: ['**/action.yml', '**/action.yaml', '**/README.md'],
    toolDescriptionTemplate: (o, r) =>
      `Look up GitHub Actions in ${o}/${r} — available actions, inputs, outputs, and usage`,
  },
  'cicd-workflows': {
    id: 'cicd-workflows',
    displayName: 'CI/CD workflows',
    wizardDescription: '.github/workflows/** — one chunk per workflow file',
    includePatterns: ['.github/workflows/**', '**/README.md'],
    toolDescriptionTemplate: (o, r) =>
      `Search CI/CD workflow definitions in ${o}/${r} — pipelines, jobs, and triggers`,
  },
  'openapi-specs': {
    id: 'openapi-specs',
    displayName: 'OpenAPI / specs',
    wizardDescription: 'YAML/JSON API spec files',
    includePatterns: ['**/*.yaml', '**/*.yml', '**/*.json', 'openapi/**', 'swagger/**', '**/README.md'],
    toolDescriptionTemplate: (o, r) =>
      `Search API specs in ${o}/${r} — endpoints, operations, and schemas`,
  },
};
