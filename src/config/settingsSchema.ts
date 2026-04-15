export interface YoinkSettings {
  'yoink.embedding.provider': 'openai' | 'azure-openai' | 'local';
  'yoink.embedding.openai.model': string;
  'yoink.embedding.openai.baseUrl': string;
  'yoink.embedding.azure.endpoint': string;
  'yoink.embedding.azure.deploymentName': string;
  'yoink.embedding.azure.apiVersion': string;
  'yoink.embedding.azure.dimensions': number;
  'yoink.embedding.local.baseUrl': string;
  'yoink.embedding.local.model': string;
  'yoink.embedding.local.dimensions': number;
  'yoink.search.topK': number;
  'yoink.sync.onStartup': boolean;
  'yoink.log.level': 'debug' | 'info' | 'warn' | 'error';
}

export const SETTING_KEYS = {
  EMBEDDING_PROVIDER: 'yoink.embedding.provider',
  OPENAI_MODEL: 'yoink.embedding.openai.model',
  OPENAI_BASE_URL: 'yoink.embedding.openai.baseUrl',
  AZURE_ENDPOINT: 'yoink.embedding.azure.endpoint',
  AZURE_DEPLOYMENT_NAME: 'yoink.embedding.azure.deploymentName',
  AZURE_API_VERSION: 'yoink.embedding.azure.apiVersion',
  AZURE_DIMENSIONS: 'yoink.embedding.azure.dimensions',
  LOCAL_BASE_URL: 'yoink.embedding.local.baseUrl',
  LOCAL_MODEL: 'yoink.embedding.local.model',
  LOCAL_DIMENSIONS: 'yoink.embedding.local.dimensions',
  SEARCH_TOP_K: 'yoink.search.topK',
  SYNC_ON_STARTUP: 'yoink.sync.onStartup',
  LOG_LEVEL: 'yoink.log.level',
} as const;
