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

export type DataSourceStatus = 'queued' | 'indexing' | 'ready' | 'error';

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  dataSourceIds: string[];
}

export interface YoinkConfig {
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

export interface ShareableTool {
  name: string;
  description: string;
  dataSources: string[]; // "owner/repo@branch" references
}

export interface ShareableConfig {
  $schema?: string;
  version: number;
  dataSources: ShareableDataSource[];
  tools: ShareableTool[];
  defaultExcludePatterns?: string[];
}

export function createDefaultConfig(): YoinkConfig {
  return {
    version: 1,
    dataSources: [],
    tools: [],
    defaultExcludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
  };
}
