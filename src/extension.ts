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
import { ParserRegistry } from './ingestion/parserRegistry';
import { Retriever } from './retrieval/retriever';
import { ContextBuilder } from './retrieval/contextBuilder';
import { ToolHandler } from './tools/toolHandler';
import { ToolManager } from './tools/toolManager';
import { DataSourceTreeProvider, ToolTreeProvider, EmbeddingTreeProvider } from './ui/sidebar/sidebarProvider';
import { AddRepoWizard } from './ui/wizard/addRepoWizard';
import { registerCommands } from './ui/commands';
import { WorkspaceConfigManager } from './config/workspaceConfig';
import { DeltaSync } from './sources/sync/deltaSync';
import { Logger } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.info('Yoink activating');

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
  const db = openDatabase({ storagePath: context.globalStorageUri.fsPath });
  const chunkStore = new ChunkStore(db);
  const embeddingStore = new EmbeddingStore(db);
  const syncStore = new SyncStore(db);

  // Delta sync
  const deltaSync = new DeltaSync(getToken);

  // AST parser registry (lazy — WASM grammars load on first use)
  const parserRegistry = new ParserRegistry({
    extensionPath: context.extensionUri.fsPath,
    queryDir: vscode.Uri.joinPath(context.extensionUri, 'dist', 'queries').fsPath,
    logger,
  });

  // Ingestion
  const pipeline = new IngestionPipeline(
    configManager,
    providerRegistry,
    fetcher,
    chunkStore,
    embeddingStore,
    syncStore,
    logger,
    deltaSync,
    parserRegistry,
  );

  // Surface pipeline errors as VS Code notifications
  pipeline.onIndexingError((dataSourceId, message) => {
    const ds = configManager.getDataSource(dataSourceId);
    const label = ds ? `${ds.owner}/${ds.repo}` : dataSourceId;
    vscode.window.showErrorMessage(`Yoink: Indexing failed for ${label}: ${message}`);
  });

  // Data source management
  const dataSourceManager = new DataSourceManager(configManager, pipeline, providerRegistry);

  // Retrieval
  const retriever = new Retriever(chunkStore, embeddingStore);
  const contextBuilder = new ContextBuilder(configManager);

  // Tools
  const toolHandler = new ToolHandler(
    configManager,
    providerRegistry,
    retriever,
    contextBuilder,
    chunkStore,
    fetcher,
  );
  const toolManager = new ToolManager(toolHandler, logger);
  toolManager.registerAll();

  // Sidebar
  const dataSourceTreeProvider = new DataSourceTreeProvider(configManager, chunkStore);
  const toolTreeProvider = new ToolTreeProvider(configManager);
  const embeddingTreeProvider = new EmbeddingTreeProvider(providerRegistry, context.secrets);
  vscode.window.registerTreeDataProvider('yoink.dataSources', dataSourceTreeProvider);
  vscode.window.registerTreeDataProvider('yoink.tools', toolTreeProvider);
  vscode.window.registerTreeDataProvider('yoink.embedding', embeddingTreeProvider);

  // Workspace config (shareable)
  const workspaceConfigManager = new WorkspaceConfigManager(
    configManager,
    dataSourceManager,
    logger,
  );

  // Commands
  registerCommands(
    context,
    configManager,
    dataSourceManager,
    providerRegistry,
    () => new AddRepoWizard(resolver, browser, dataSourceManager, configManager, providerRegistry),
    workspaceConfigManager,
  );

  // Sync scheduler
  const scheduler = new SyncScheduler(configManager, (id) => dataSourceManager.sync(id));
  scheduler.start();

  // Disposables
  context.subscriptions.push(
    configManager,
    { dispose: () => pipeline.dispose() },
    dataSourceManager,
    toolManager,
    scheduler,
    embeddingTreeProvider,
    logger,
  );

  // Detect workspace config and prompt import
  workspaceConfigManager.detectAndPrompt();

  logger.info('Yoink activated');
}

export function deactivate(): void {
  // Disposables are cleaned up by VS Code via context.subscriptions
}
