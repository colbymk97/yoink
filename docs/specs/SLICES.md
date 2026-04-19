# Yoink — Implementation Slices

This document breaks the Yoink architecture into ordered implementation
slices. Each slice is vertically integrated — it produces something testable
and builds on the previous slice. No slice should take more than a focused
session to implement.

---

## Slice 1: Storage Foundation

**Goal:** SQLite database initializes, migrates, and round-trips data without
any VS Code APIs.

**Files:**
- `src/storage/database.ts` — resolve sqlite-vec extension path from
  `node_modules`, open DB, run migrations, create all tables including vec0
- `src/storage/chunkStore.ts` — insert, query, delete chunks
- `src/storage/embeddingStore.ts` — insert embeddings, vector search via
  `MATCH`, delete by chunk IDs
- `src/storage/syncStore.ts` — start/complete/fail sync records

**Work:**
1. Wire `sqlite-vec` extension loading — resolve the platform-specific binary
   from the `sqlite-vec` npm package at runtime
2. Make `openDatabase()` work end-to-end: create DB file, load extension,
   run migrations, return `Database` instance
3. Write unit tests for each store: insert → query round-trip, delete
   cascades, vec0 search returns ranked results with known vectors

**Acceptance:**
- `npm test` passes with an in-memory or temp-file SQLite DB
- Vector search returns correct nearest neighbors for synthetic embeddings
- Schema version is tracked in `meta` table

**Dependencies:** None

---

## Slice 2: Embedding Provider

**Goal:** OpenAI embedding provider embeds text and counts tokens.

**Files:**
- `src/embedding/embeddingProvider.ts` — interface (already scaffolded)
- `src/embedding/openaiProvider.ts` — OpenAI API calls, batch handling
- `src/embedding/registry.ts` — resolve API key from SecretStorage / env,
  construct provider from VS Code settings

**Work:**
1. Integrate `tiktoken` WASM for accurate token counting in
   `OpenAIEmbeddingProvider.countTokens()`
2. Add batch splitting — if input exceeds `maxBatchSize`, split into
   sub-batches and concatenate results
3. Add retry with exponential backoff for transient OpenAI API errors
   (429, 500, 503)
4. Implement `EmbeddingProviderRegistry.resolveApiKey()` — SecretStorage
   first, then `process.env.OPENAI_API_KEY`
5. Unit tests: mock `fetch` to verify request format, batch splitting,
   error handling

**Acceptance:**
- Provider embeds a batch of strings and returns correctly ordered vectors
- Token counting matches tiktoken output for sample code strings
- Missing API key throws a descriptive error

**Dependencies:** None (can run in parallel with Slice 1)

---

## Slice 3: GitHub Data Fetching

**Goal:** Fetch file trees and contents from GitHub repos via the API.

**Files:**
- `src/auth/githubAuth.ts` — get/check GitHub OAuth session
- `src/sources/github/githubFetcher.ts` — Trees API, Blobs API, concurrent
  file fetching
- `src/sources/github/githubResolver.ts` — parse URLs, resolve repo metadata
  and default branch
- `src/sources/github/repoBrowser.ts` — list user repos, search repos

**Work:**
1. Implement `parseRepoUrl()` with edge cases: trailing slash, `.git` suffix,
   SSH URLs (reject with message), enterprise URLs (reject for v1)
2. Implement `GitHubFetcher.getTree()` — handle `truncated: true` response
   (log warning, still return partial tree)
3. Implement `GitHubFetcher.fetchFiles()` — concurrent blob fetching with
   configurable concurrency, skip binary blobs (check content type or size
   threshold)
4. Add rate limit awareness — read `X-RateLimit-Remaining` header, pause
   if approaching zero
5. Unit tests with fixture JSON responses for tree/blob/compare endpoints

**Acceptance:**
- Can resolve `https://github.com/owner/repo` → metadata with default branch
- Can fetch full file tree and file contents for a small test repo
- Rate limit headers are respected

**Dependencies:** None (can run in parallel with Slices 1-2)

---

## Slice 4: Ingestion Pipeline

**Goal:** Given a data source config, fetch → filter → chunk → embed → store.
The first complete data path.

**Files:**
- `src/ingestion/pipeline.ts` — orchestrator with concurrent queue
- `src/ingestion/chunker.ts` — fixed-size overlap chunking
- `src/ingestion/fileFilter.ts` — glob include/exclude matching

**Work:**
1. Implement `Chunker.chunkFile()` — use tiktoken (via provider's
   `countTokens`) for accurate chunk sizing, respect line boundaries
2. Implement `FileFilter` — apply include + exclude patterns using
   `minimatch`, merge data source patterns with `defaultExcludePatterns`
3. Wire `IngestionPipeline.ingestDataSource()`:
   - Fetch tree → filter → fetch blobs → chunk → embed → store
   - Update data source status at each phase
   - Record sync history on success/failure
4. Implement the concurrent queue (`enqueue`, `processQueue`) with
   concurrency limit of 3
5. Integration test: mock GitHub API + mock embedding provider, verify
   chunks and embeddings appear in SQLite after pipeline run

**Acceptance:**
- Pipeline processes a mock data source end-to-end
- Chunks are correctly sized with overlap
- File filter correctly includes/excludes by glob
- Queue respects concurrency limit

**Dependencies:** Slices 1, 2, 3

---

## Slice 5: Retrieval & Tool Registration

**Goal:** Copilot can invoke a registered tool and get back search results.
The first time the extension is actually useful.

**Files:**
- `src/retrieval/retriever.ts` — embed query, vector search, return chunks
- `src/retrieval/contextBuilder.ts` — format results for Copilot
- `src/tools/toolHandler.ts` — handle tool invocations
- `src/tools/toolManager.ts` — register/unregister tools dynamically
- `src/tools/globalSearchTool.ts` — metadata for the always-on tool

**Work:**
1. Implement `Retriever.search()` — embed query, run vec0 search scoped to
   data source IDs, join with chunks to hydrate results
2. Implement `ContextBuilder.format()` — produce markdown with file path,
   line range, repo attribution, and code block per result
3. Implement `ToolHandler.handle()` and `handleGlobalSearch()` — resolve
   data sources, call retriever, format response
4. Implement `ToolManager.registerAll()` — register global search tool +
   all user tools, handle config change events for dynamic re-registration
5. Integration test: seed DB with known chunks/embeddings, invoke tool
   handler, verify formatted output

**Acceptance:**
- `yoink-search` tool is registered on activation
- Querying the tool returns correctly formatted, ranked results
- Adding/removing a tool in config triggers registration/disposal

**Dependencies:** Slices 1, 2, 4

---

## Slice 6: Config & Extension Wiring

**Goal:** Extension activates cleanly, reads/writes config, and manages the
full lifecycle from `activate()` to `deactivate()`.

**Files:**
- `src/config/configManager.ts` — read/write/watch `yoink.json`
- `src/config/configSchema.ts` — types + defaults
- `src/extension.ts` — full dependency wiring

**Work:**
1. Harden `ConfigManager` — handle corrupt JSON (reset to defaults with
   backup), handle missing directory, debounce writes
2. Wire `extension.ts` `activate()` with real sqlite-vec extension path
   resolution
3. Register all disposables correctly — verify no resource leaks on
   deactivate
4. Add config file watcher — if user edits `yoink.json` externally,
   reload and re-sync tool registrations
5. Integration test: activate extension in VS Code Extension Test Host,
   verify tools register, config persists across activate/deactivate cycles

**Acceptance:**
- Extension activates without errors
- Config survives write → read → write cycles
- All disposables clean up on deactivate

**Dependencies:** Slices 1-5

---

## Slice 7: Add Repository Wizard

**Goal:** User can add a repo via the command palette, end to end.

**Files:**
- `src/ui/wizard/addRepoWizard.ts` — multi-step QuickPick/InputBox flow
- `src/ui/commands.ts` — command registrations
- `src/sources/dataSourceManager.ts` — CRUD + sync triggering

**Work:**
1. Implement the full wizard flow: URL or browse → resolve → branch →
   include patterns → sync schedule → tool name → tool description
2. Wire `DataSourceManager.add()` — write config + enqueue for indexing
3. Implement all commands: add, remove, sync, sync all, set API key,
   edit tool
4. Add input validation: repo URL format, tool name constraints,
   duplicate detection (same owner/repo/branch already exists)
5. Manual test: run extension in Extension Development Host, walk through
   wizard, verify config file and DB are populated

**Acceptance:**
- Complete wizard flow works from command palette
- Config + tool created, indexing begins automatically
- Remove command cleans up config, DB chunks, and tool registration

**Dependencies:** Slices 4, 5, 6

---

## Slice 8: Sidebar UI

**Goal:** Sidebar panel shows data sources and tools with live status.

**Files:**
- `src/ui/sidebar/sidebarProvider.ts` — tree data providers
- `src/ui/sidebar/sidebarTreeItems.ts` — tree item rendering

**Work:**
1. Implement `DataSourceTreeProvider` — show each data source with
   status icon (queued/indexing/ready/error), branch, last synced time
2. Implement `ToolTreeProvider` — show each tool with source count and
   mapped repo names
3. Wire config change events to `refresh()` — sidebar updates in real time
   as indexing progresses
4. Add context menu actions on tree items: sync, remove (data sources);
   edit (tools)
5. Manual test: add repos, watch status change from queued → indexing →
   ready in the sidebar

**Acceptance:**
- Both tree views populate from config
- Status icons update as indexing progresses
- Context menu actions work

**Dependencies:** Slice 7

---

## Slice 9: Sync & Delta Updates

**Goal:** Data sources stay up to date without full re-indexing.

**Files:**
- `src/sources/sync/deltaSync.ts` — GitHub Compare API integration
- `src/sources/sync/syncScheduler.ts` — on-startup and daily triggers
- `src/ingestion/pipeline.ts` — delta-aware ingestion path

**Work:**
1. Implement `DeltaSync.computeDelta()` — call Compare API, classify
   files as added/modified/deleted
2. Add delta-aware path in `IngestionPipeline` — if `lastSyncCommitSha`
   exists, compute delta and only process changed files instead of full
   re-index
3. Handle deleted files — remove their chunks and embeddings
4. Handle modified files — delete old chunks, re-chunk, re-embed
5. Implement `SyncScheduler` — trigger on-startup sources at activation,
   run hourly check for daily sources
6. Integration test: seed DB with initial index, simulate file changes
   via mock Compare API, verify only changed chunks are updated

**Acceptance:**
- Delta sync correctly identifies and processes only changed files
- Deleted file chunks are removed from DB
- Scheduler triggers syncs at correct intervals
- Full re-index still works when `lastSyncCommitSha` is null

**Dependencies:** Slices 4, 6

---

## Slice 10: Error Handling, Polish & Edge Cases

**Goal:** Production-ready error handling and UX polish.

**Files:** Cross-cutting across all modules.

**Work:**
1. GitHub API error handling — auth expired (re-prompt), repo not found,
   rate limited (backoff + notification), network offline
2. Embedding API error handling — invalid key, quota exceeded, model not
   found, timeout
3. Large repo guardrails — warn if tree has >10K files after filtering,
   show progress notification with cancel during indexing
4. Progress reporting — `vscode.window.withProgress()` for indexing with
   file count / chunk count updates
5. Duplicate prevention — prevent adding same owner/repo/branch twice
6. Config corruption recovery — detect invalid JSON, offer to reset
7. Logging — ensure all error paths log to the Yoink output channel
   with enough context to diagnose

**Acceptance:**
- Extension never shows unhandled promise rejection
- All error states show user-friendly notifications
- Large repo indexing can be cancelled
- Corrupt config recovers gracefully

**Dependencies:** All previous slices

---

## Dependency Graph

```
Slice 1 (Storage) ──────┐
                         │
Slice 2 (Embedding) ─────┤
                         ├── Slice 4 (Ingestion) ──┐
Slice 3 (GitHub API) ────┘                         │
                                                   ├── Slice 5 (Retrieval + Tools)
                                                   │
                                              Slice 6 (Config + Wiring) ── Slice 7 (Wizard)
                                                   │                           │
                                                   │                      Slice 8 (Sidebar)
                                                   │
                                              Slice 9 (Sync + Delta)
                                                   │
                                              Slice 10 (Polish)
```

**Parallelism:** Slices 1, 2, and 3 have no dependencies on each other and
can be implemented simultaneously.
