# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript compile (tsc → dist/)
npm run lint           # ESLint with typescript-eslint
npm test               # Vitest (all tests)
npm run test:watch     # Vitest in watch mode

# Run a single test file
npx vitest run test/unit/storage/database.test.ts
```

**Note:** Storage tests (`test/unit/storage/`) crash locally on Apple Silicon when Node runs as x64 under Rosetta 2 — `sqlite-vec`'s prebuilt binary uses AVX instructions Rosetta doesn't support. These tests pass on native x86_64 (GitHub CI). Embedding tests always pass.

## Dev Workflow (build → install → run)

```bash
npm run dev:install    # build + vsce package + code --install-extension + open new window
# or directly:
bash scripts/dev-install.sh
```

This produces `yoink-dev.vsix`, installs it, and opens a new VS Code window. Use this whenever you want to manually test a change end-to-end.

**Viewing logs:** View → Output → select **Yoink**. Set `yoink.log.level = "debug"` in settings for verbose output.

## Packaging and Local Install

```bash
npm run build                                    # compile TypeScript first
npm run package                                  # vsce package → yoink-0.0.1.vsix
code --install-extension yoink-0.0.1.vsix     # install into VS Code
```

To uninstall:

```bash
code --uninstall-extension yoink.yoink
```

Dependencies (including native modules like `better-sqlite3` and `sqlite-vec`) are bundled into the VSIX. CI builds platform-specific VSIXs via `vsce package --target <platform>` on matching runners (linux-x64, darwin-arm64, darwin-x64).

**Apple Silicon note:** `dev-install.sh` detects x64 Node running under Rosetta and automatically rebuilds native modules for arm64 before packaging.

## Releasing

Push a version tag to trigger the release workflow, which builds platform-specific VSIXs and publishes a GitHub release:

```bash
git tag v0.0.1
git push origin v0.0.1
```

The workflow (`.github/workflows/release.yml`) runs on any `v*` tag, builds for each platform via `_build.yml`, and attaches all VSIXs to the release.

## Architecture Overview

Yoink is a VS Code extension that indexes GitHub repositories into a local SQLite database and exposes them as Copilot Chat tools. Users configure repos and tools via a sidebar; Copilot agents call the tools to retrieve code, documentation, and structure.

### Module Map

| Directory | Responsibility |
|-----------|---------------|
| `src/extension.ts` | Composition root — constructs every service, wires dependencies, holds disposables |
| `src/config/` | Config schemas, `ConfigManager` (yoink.json), workspace config import/export, repo type presets, VS Code settings keys |
| `src/sources/` | `DataSourceManager` (add/remove/sync), `dataSource.ts` (status model), GitHub fetcher/resolver/repoBrowser, delta sync, sync scheduler |
| `src/ingestion/` | `IngestionPipeline`, `Chunker` (strategy router), `AstChunker` (tree-sitter), `fileFilter`, `languageDetection`, `parserRegistry`, `progressTracker` |
| `src/storage/` | SQLite layer — `database.ts` (migrations), `ChunkStore`, `EmbeddingStore` (vec0 + FTS5), `DataSourceStore`, `SyncStore` |
| `src/embedding/` | `EmbeddingProvider` interface, OpenAI / Azure OpenAI / local providers, registry, pricing |
| `src/retrieval/` | `Retriever` (hybrid search: vec KNN + BM25 + path RRF), `ContextBuilder` (formats results as markdown) |
| `src/tools/` | Tool metadata files (`*Tool.ts`), `ToolHandler` (one method per tool), `ToolManager` (registers with `vscode.lm`) |
| `src/ui/` | Sidebar tree provider/items, `AddRepoWizard`, command registrations |
| `src/agents/` | `AgentInstaller` — copies `.md` agent files to `.copilot/agents/` in the workspace |
| `src/auth/` | GitHub OAuth token management |
| `src/util/` | `Logger`, disposable helpers |

### Dependency Wiring

`src/extension.ts` is the composition root. Its `activate()` function constructs every service, injects dependencies, and holds all disposables. Nothing is a singleton — all instances are created here and passed down.

### Data Pipeline (write path)

```
GitHub Trees API → fileFilter (glob) → tarball download (full index)
                                      or blob API (delta sync)
  → Chunker.routeStrategy (per-file strategy selection)
  → chunkFile() → EmbeddingProvider.embed() → ChunkStore + EmbeddingStore
```

`src/ingestion/pipeline.ts` orchestrates this. A concurrent queue (limit: 3 parallel data sources) is managed inside the pipeline. Status transitions (`queued → indexing → ready | error`) are written to both the SQLite `data_sources` table and `yoink.json`.

### Chunking

The chunker (`src/ingestion/chunker.ts`) picks a strategy **per file**, based on path/extension. A single `Chunker` instance handles every file in an ingest run — polyglot repos (code + docs + workflows) are chunked correctly without any per-data-source configuration. `RepoTypePreset` (`src/config/repoTypePresets.ts`) only drives the include-pattern filter; it has no strategy field.

Routing (`Chunker.routeStrategy`, in order):

| Match                                         | Strategy           |
|-----------------------------------------------|--------------------|
| `*.md`, `*.mdx`                               | `markdown-heading` |
| `.github/workflows/*.yml` / `*.yaml`          | `file-level`       |
| `action.yml` / `action.yaml` (any depth)      | `file-level`       |
| Extension in `languageDetection` table        | `ast-based`        |
| Everything else                               | `token-split`      |

Strategy behaviors:

| Strategy           | What it does                                                              |
|--------------------|---------------------------------------------------------------------------|
| `token-split`      | Fixed-size token windows with overlap (default 512 / 64).                 |
| `file-level`       | One chunk per file. Good for action.yml and workflow YAML.                |
| `markdown-heading` | Splits on `#` headings; oversized sections fall back to `token-split`.    |
| `ast-based`        | Tree-sitter — one chunk per top-level function, method, or class.         |

`ast-based` details:
- `languageDetection.ts` maps the extension to a supported language
  (TypeScript, TSX, JS/JSX, Python, Go, Java, C#, Rust, Ruby).
- Parse failures or files with no captured definitions fall back to
  `chunkByTokens` for the whole file.
- When `parserRegistry` is absent (e.g. in unit tests), routing degrades
  AST files to `token-split` rather than throwing.
- Each method chunk is prefixed with a comment header naming its enclosing
  class (`// Class: UserService` / `# Class: Greeter`). Go uses the receiver,
  Rust uses the `impl` target type.
- Classes that contain methods are not emitted as their own chunk (the
  methods cover them, prefixed with the class name); empty classes /
  data classes / interfaces emit as a single chunk.
- Oversized definitions are split via the strategy's `fallback`
  (token-split), with line numbers offset to the node's position.

`Chunker.chunkFile` is `async` because `ast-based` lazy-loads WASM grammars
on first use. The other strategies await trivially.

`ChunkerOptions` exposes an optional `strategy` field that **forces** a
single strategy for every file. This is intended for tests; production code
in `pipeline.ts` leaves it unset so routing is used.

#### How to change the routing table

`Chunker.routeStrategy` in `src/ingestion/chunker.ts` is the single source of
truth. Add a branch above the default `token-split` return; cover it in
`test/unit/ingestion/chunker.test.ts` under the `Chunker.routeStrategy`
block.

#### How to add a new strategy

1. Add the literal to `ChunkingStrategy` in `src/ingestion/chunker.ts`.
2. Add a private method to `Chunker` implementing it; dispatch from
   `Chunker#dispatch` with a single `if` branch.
3. Add a routing rule to `Chunker.routeStrategy` (or rely on the forced
   `strategy` option for test-only use).
4. If it needs external dependencies, add an optional field to
   `ChunkerOptions`, thread it through `pipeline.ts` and `extension.ts`,
   and handle absence gracefully in the routing path.
5. Add unit tests in `test/unit/ingestion/chunker.test.ts`.

#### How to add a new language to the AST strategy

1. Verify the WASM grammar is available in
   `node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-<lang>.wasm`
   (or add a different source).
2. Extend `SupportedLanguage` in `src/ingestion/languageDetection.ts` and
   map any file extensions in `EXTENSION_TO_LANGUAGE`. Set the comment
   prefix in `lineCommentPrefix` if it isn't `//`.
3. Add a query file at `src/chunking/queries/<lang>.scm` capturing
   `@definition.function`, `@definition.method`, and/or `@definition.class`.
4. Add the WASM filename to `WASM_FILENAME` in
   `src/ingestion/parserRegistry.ts`.
5. Add the language's class-like node types to `CONTAINER_TYPES` in
   `src/ingestion/astChunker.ts` so methods get a parent-class prefix.
   For languages without classes (Go-style methods), special-case in
   `resolveContainerName`.
6. Update the `source-code` preset's `includePatterns` to include the
   new extension (the router picks it up automatically via
   `detectLanguage`).
7. Add a fixture under `test/fixtures/ast/` and assertions in
   `test/unit/ingestion/astChunker.test.ts`.

Queries live in `src/chunking/queries/` and are copied to `dist/queries/`
by `scripts/copy-queries.mjs` (chained from `npm run build`). The VSIX
packaging step (`.vscodeignore`) ships both `dist/queries/**` and
`node_modules/@vscode/tree-sitter-wasm/**`.

### Repo Type Presets

`REPO_TYPE_PRESETS` (`src/config/repoTypePresets.ts`) is a user-facing
catalog of default include patterns and tool descriptions — not a strategy
selector. Each preset answers "what files do I want indexed?":

| Preset                    | Include filter                                                                  |
|---------------------------|---------------------------------------------------------------------------------|
| `general`                 | no filter (everything passes)                                                   |
| `documentation`           | `**/*.md`, `**/*.mdx`, `docs/**`, `wiki/**`                                     |
| `source-code`             | `**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,cs,rs,rb,md,mdx}` — code + inline docs  |
| `github-actions-library`  | `**/action.yml`, `**/action.yaml`, `**/README.md`                               |
| `cicd-workflows`          | `.github/workflows/**`                                                          |
| `openapi-specs`           | `**/*.yaml`, `**/*.yml`, `**/*.json`, `openapi/**`, `swagger/**`                |

A single data source can mix file types — e.g. `source-code` indexes both
TypeScript and Markdown, and each file gets its own strategy via the router.

### How to add a new Copilot tool

Every built-in tool touches five places. Do all five or the tool won't be visible to the LLM.

1. **`src/tools/<name>Tool.ts`** — tool metadata only (name, displayName, description, inputSchema). Follow the pattern in `getFileTool.ts`.

2. **`src/tools/toolHandler.ts`** — add an `async handle<Name>(options, token)` method. Call `getReadySources(options.input.repository)` to resolve and validate the target data sources, then return a `vscode.LanguageModelToolResult`.

3. **`src/tools/toolManager.ts`** — add a private `register<Name>Tool()` method following the pattern of `registerGetFileTool()` (lines 58–77). Call it from `registerAll()`. Add its internal key (e.g. `'__name__'`) to the `reserved` set so `syncRegistrations()` doesn't unregister it.

4. **`package.json` `contributes.languageModelTools`** — add a full entry with:
   - `"canBeReferencedInPrompt": true` — **required** for the tool to be visible and referenceable in Copilot Chat
   - `"modelDescription"` — written for the LLM: when to call this tool, what it returns, how it relates to other tools
   - `"userDescription"` — one sentence for the VS Code UI
   - `"inputSchema"` — must match the TypeScript input type exactly

5. **`agents/yoink-agent.md`** — add a row to the Tools Available table and update the Workflow / Best Practices sections if the tool changes recommended call order. Also update `agents/yoink-cicd-agent.md` if relevant to CI/CD workflows.

**Tests:** add unit tests in `test/unit/tools/`. Pure logic (tree building, formatting, filtering) belongs in a dedicated helper file so it can be tested without vscode or sqlite.

### Query Path (read path)

```
Copilot invokes tool → ToolHandler method
  → getReadySources() filters to ready data sources
  → Retriever.search():
      ├─ EmbeddingProvider.embed(query) → vec0 KNN (sqlite-vec)    ┐
      ├─ ChunkStore.searchFts(query)    → FTS5 BM25 (chunks_fts)   ├─ 3× over-fetch each
      └─ pathRelevance(filePath, queryTokens)                      ┘
      → Reciprocal Rank Fusion → path boost → top K
  → ContextBuilder.format() → markdown → Copilot
```

Search uses three signals merged with RRF (k=60). See `docs/app/search.md` for full details. Always scope `embeddingStore.search()` calls with `data_source_id IN (...)` to avoid full-table scans.

### Sync System

`SyncScheduler` (`src/sources/sync/syncScheduler.ts`) fires sync jobs on activation (`onStartup` sources) and on a 1-hour tick (`daily` sources). It calls `DataSourceManager.sync()` which delegates to `IngestionPipeline`.

`DeltaSync` (`src/sources/sync/deltaSync.ts`) calls GitHub's Compare API between `lastSyncCommitSha` and HEAD. Added/modified files are re-chunked and re-embedded; deleted files have their chunks, embeddings, and FTS rows removed. A null `lastSyncCommitSha` triggers a full re-index.

### Embedding Providers

`EmbeddingProvider` (`src/embedding/embeddingProvider.ts`): interface with `embed(texts[])`, `dimensions`, and optional `countTokens()`. The registry (`src/embedding/registry.ts`) builds the concrete provider from VS Code settings:

| Provider | Setting value | Dimensions |
|----------|--------------|------------|
| OpenAI `text-embedding-3-small` | `openai` (default) | 1536 |
| Azure OpenAI | `azure-openai` | configurable |
| Local (no-op / test) | `local` | 4 |

Changing providers requires dropping and recreating the `embeddings` vec0 table — different dimensions make the index incompatible. `recreateEmbeddingsTable()` in `database.ts` handles this.

### Copilot Tools

Six built-in tools registered at activation via `ToolManager.registerAll()`:

| Tool name | Handler method | What it does |
|-----------|---------------|-------------|
| `yoink-search` | `handleGlobalSearch` | Hybrid vector + keyword search across indexed repos |
| `yoink-list` | `handleList` | Lists all data sources and tools with status |
| `yoink-get-files` | `handleGetFiles` | Returns full content of 1–10 files from GitHub (≤ 500 KB each, ≤ 2 MB total) |
| `yoink-file-tree` | `handleFileTree` | Deterministic directory/file hierarchy from indexed chunks |
| `yoink-list-workflows` | `handleListWorkflows` | Lists `.github/workflows/` files with triggers |
| `yoink-list-actions` | `handleListActions` | Lists `action.yml` files with names and inputs |

All tool metadata (name, schema, `modelDescription`) lives in `src/tools/*Tool.ts`. Handlers live in `src/tools/toolHandler.ts`. Every tool must also have a `languageModelTools` entry in `package.json` with `canBeReferencedInPrompt: true` — see "How to add a new Copilot tool" below.

### Key Abstractions

**`EmbeddingProvider`** (`src/embedding/embeddingProvider.ts`): Interface with `embed(texts)`, `dimensions`, and optional `countTokens()`. The registry (`src/embedding/registry.ts`) builds the concrete provider from VS Code settings. Changing providers requires dropping and recreating the `embeddings` vec0 table (different dimensions).

**`DataSourceConfig`** (`src/config/configSchema.ts`): The canonical representation of a repo. Written to `{globalStorageUri}/yoink.json` by `ConfigManager`. Mirrored into the `data_sources` SQLite table for query joins.

**`ToolConfig`** (`src/config/configSchema.ts`): Each tool maps `dataSourceIds[]` → a `vscode.lm.registerTool()` call. `ToolManager` diffs config on every change event and re-registers as needed.

### Config Layering

Two config systems coexist:
- **`yoink.json`** (in `globalStorageUri`): user data — data sources, tools, sync state. Managed by `ConfigManager`, watched for external edits.
- **VS Code settings** (`yoink.*` in `package.json` `contributes.configuration`): operational settings — embedding provider, API base URL, log level, topK. Read via `vscode.workspace.getConfiguration()`.

### API Key Storage

Resolution order: `SecretStorage` (OS keychain) → `OPENAI_API_KEY` env var → prompt user. Keys are never written to `settings.json` or `yoink.json`.

### SQLite Schema (v3)

| Table | Type | Purpose |
|-------|------|---------|
| `meta` | regular | Key-value store — `schema_version`, `embedding_dimensions` |
| `data_sources` | regular | One row per indexed repo — owner, repo, branch, status, last sync |
| `chunks` | regular | Indexed content — `file_path`, `start_line`, `end_line`, `content`, `token_count` |
| `sync_history` | regular | Per-sync audit log — status, files processed, commit SHA |
| `embeddings` | vec0 virtual | `sqlite-vec` KNN table — `chunk_id`, `embedding FLOAT[N]` |
| `chunks_fts` | FTS5 virtual | BM25 keyword index — `file_path` (5× weight) + `content` (1× weight) |

`embeddings` dimensions are fixed at DB creation time (default 1536). Schema version is tracked in `meta`; migrations run in `database.ts:migrate()`. FTS5 uses `porter ascii` tokenizer and is kept in sync by `ChunkStore` on every insert/delete.

All tests use in-memory SQLite databases — no shared state between test files. Storage tests (`test/unit/storage/`) and retrieval tests crash on Apple Silicon under Rosetta (x86_64 Node + arm64 `better-sqlite3`) — they pass on native x86_64 (CI).

### Docs Structure

```
docs/
  app/      — how the running system works (search.md, etc.)
  specs/    — feature designs, improvement plans, slice tracking
```
