import * as vscode from 'vscode';
import { ConfigManager } from './config/configManager';
import { GitHubAuth } from './auth/githubAuth';
import { GitHubFetcher } from './sources/github/githubFetcher';
import { GitHubResolver } from './sources/github/githubResolver';
import { RepoBrowser } from './sources/github/repoBrowser';
import { DataSourceManager } from './sources/dataSourceManager';
import { SyncScheduler } from './sources/sync/syncScheduler';
import { EmbeddingProviderRegistry } from './embedding/registry';
import { openDatabase } from './storage/database';
import { ChunkStore } from './storage/chunkStore';
import { EmbeddingStore } from './storage/embeddingStore';
import { SyncStore } from './storage/syncStore';
import { IngestionPipeline } from './ingestion/pipeline';
import { Retriever } from './retrieval/retriever';
import { ContextBuilder } from './retrieval/contextBuilder';
import { ToolHandler } from './tools/toolHandler';
import { ToolManager } from './tools/toolManager';
import { DataSourceTreeProvider, ToolTreeProvider } from './ui/sidebar/sidebarProvider';
import { AddRepoWizard } from './ui/wizard/addRepoWizard';
import { registerCommands } from './ui/commands';
import { Logger } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.info('RepoLens activating');

  // Config
  const configManager = new ConfigManager(context.globalStorageUri);

  // Auth
  const auth = new GitHubAuth();
  const getToken = () => auth.getToken();

  // GitHub services
  const fetcher = new GitHubFetcher(getToken);
  const resolver = new GitHubResolver(getToken);
  const browser = new RepoBrowser(getToken);

  // Embedding
  const providerRegistry = new EmbeddingProviderRegistry(context.secrets);

  // Storage
  // TODO: resolve sqlite-vec extension path from node_modules
  const vecExtensionPath = '';
  const db = openDatabase(context.globalStorageUri.fsPath, vecExtensionPath);
  const chunkStore = new ChunkStore(db);
  const embeddingStore = new EmbeddingStore(db);
  const syncStore = new SyncStore(db);

  // Ingestion
  const pipeline = new IngestionPipeline(
    configManager,
    providerRegistry,
    fetcher,
    chunkStore,
    embeddingStore,
    syncStore,
    logger,
  );

  // Data source management
  const dataSourceManager = new DataSourceManager(configManager, pipeline);

  // Retrieval
  const retriever = new Retriever(chunkStore, embeddingStore);
  const contextBuilder = new ContextBuilder(configManager);

  // Tools
  const toolHandler = new ToolHandler(
    configManager,
    providerRegistry,
    retriever,
    contextBuilder,
  );
  const toolManager = new ToolManager(configManager, toolHandler, logger);
  toolManager.registerAll();

  // Sidebar
  const dataSourceTreeProvider = new DataSourceTreeProvider(configManager);
  const toolTreeProvider = new ToolTreeProvider(configManager);
  vscode.window.registerTreeDataProvider('repoLens.dataSources', dataSourceTreeProvider);
  vscode.window.registerTreeDataProvider('repoLens.tools', toolTreeProvider);

  // Commands
  registerCommands(
    context,
    configManager,
    dataSourceManager,
    providerRegistry,
    () => new AddRepoWizard(resolver, browser, dataSourceManager, configManager),
  );

  // Sync scheduler
  const scheduler = new SyncScheduler(configManager, (id) => dataSourceManager.sync(id));
  scheduler.start();

  // Disposables
  context.subscriptions.push(
    configManager,
    pipeline,
    dataSourceManager,
    toolManager,
    scheduler,
    logger,
  );

  logger.info('RepoLens activated');
}

export function deactivate(): void {
  // Disposables are cleaned up by VS Code via context.subscriptions
}
