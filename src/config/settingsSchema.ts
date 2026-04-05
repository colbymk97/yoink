export interface RepoLensSettings {
  'repoLens.embedding.provider': 'openai';
  'repoLens.embedding.openai.model': string;
  'repoLens.embedding.openai.baseUrl': string;
  'repoLens.search.topK': number;
  'repoLens.sync.onStartup': boolean;
  'repoLens.log.level': 'debug' | 'info' | 'warn' | 'error';
}

export const SETTING_KEYS = {
  EMBEDDING_PROVIDER: 'repoLens.embedding.provider',
  OPENAI_MODEL: 'repoLens.embedding.openai.model',
  OPENAI_BASE_URL: 'repoLens.embedding.openai.baseUrl',
  SEARCH_TOP_K: 'repoLens.search.topK',
  SYNC_ON_STARTUP: 'repoLens.sync.onStartup',
  LOG_LEVEL: 'repoLens.log.level',
} as const;
