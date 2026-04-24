import { DataSourceType } from './repoTypePresets';

export interface DataSourceConfig {
  id: string;
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  type: DataSourceType;
  description?: string;
  includePatterns: string[];
  excludePatterns: string[];
  syncSchedule: 'manual' | 'onStartup' | 'daily';
  lastSyncedAt: string | null;
  lastSyncCommitSha: string | null;
  status: DataSourceStatus;
  errorMessage?: string;
}

export type DataSourceStatus = 'queued' | 'indexing' | 'ready' | 'error' | 'deleting';

export interface YoinkConfig {
  version: number;
  dataSources: DataSourceConfig[];
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

// --- Shareable config types (for .vscode/yoink.json) ---

export interface ShareableDataSource {
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  type?: DataSourceType;
  description?: string;
  includePatterns: string[];
  excludePatterns: string[];
  syncSchedule: 'manual' | 'onStartup' | 'daily';
}

export interface ShareableConfig {
  $schema?: string;
  version: number;
  dataSources: ShareableDataSource[];
  defaultExcludePatterns?: string[];
}

export function createDefaultConfig(): YoinkConfig {
  return {
    version: 1,
    dataSources: [],
    defaultExcludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
  };
}
