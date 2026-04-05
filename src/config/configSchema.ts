export interface DataSourceConfig {
  id: string;
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  includePatterns: string[];
  excludePatterns: string[];
  syncSchedule: 'manual' | 'onStartup' | 'daily';
  lastSyncedAt: string | null;
  lastSyncCommitSha: string | null;
  status: DataSourceStatus;
  errorMessage?: string;
}

export type DataSourceStatus = 'queued' | 'indexing' | 'ready' | 'error';

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  dataSourceIds: string[];
}

export interface RepoLensConfig {
  version: number;
  dataSources: DataSourceConfig[];
  tools: ToolConfig[];
  defaultExcludePatterns: string[];
}

export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/*.min.js',
  '**/*.map',
  '**/*.png',
  '**/*.jpg',
  '**/*.gif',
  '**/*.ico',
  '**/*.woff',
  '**/*.woff2',
  '**/*.ttf',
  '**/*.eot',
];

export function createDefaultConfig(): RepoLensConfig {
  return {
    version: 1,
    dataSources: [],
    tools: [],
    defaultExcludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
  };
}
