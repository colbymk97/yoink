# Repo Type Awareness — Design Document

## Context

Yoink previously treated all indexed repos identically — same file filter
defaults, same chunking strategy, and the same generic tool description
template. Different repo shapes (Actions libraries, documentation, CI/CD
workflow repos, API specs) have radically different file structure and query
patterns. A user indexing an Actions library shouldn't have to manually
configure include patterns for `action.yml` files, and the generated tool
description shouldn't say "Search the codebase."

The `type` field on `DataSourceConfig` carries these defaults. It is set once
during wizard setup and drives include patterns, chunking strategy, and the
tool description template. All generated values are user-editable before
confirmation.

---

## 1. Preset registry

**`src/config/repoTypePresets.ts`** — no VS Code dependency, no I/O. Pure data.

Each preset is a `RepoTypePreset`:

| Field | Purpose |
|---|---|
| `id` | `DataSourceType` identifier stored in config |
| `displayName` | Shown in the wizard QuickPick |
| `wizardDescription` | Detail line under the display name |
| `includePatterns` | Default glob includes pre-populated in the wizard input |
| `chunkingStrategy` | One of `token-split`, `file-level`, `markdown-heading` |
| `toolDescriptionTemplate` | `(owner, repo) => string` — pre-populates the description step |

The registry is a `Record<DataSourceType, RepoTypePreset>` — exhaustive,
no runtime lookup failures.

---

## 2. Preset configs

### `general` (default)

| Field | Value |
|---|---|
| Include patterns | *(empty — all files)* |
| Chunking | `token-split` (512-token greedy, 64-token overlap) |
| Description template | `Search the {owner}/{repo} codebase` |

Identical to pre-type behaviour. Any existing data source without a `type`
field migrates to this.

### `documentation`

| Field | Value |
|---|---|
| Include patterns | `**/*.md`, `docs/**`, `wiki/**` |
| Chunking | `markdown-heading` — one chunk per `#` section |
| Description template | `Search {owner}/{repo} documentation and standards` |

Heading-based chunking keeps each document section as a coherent unit.
Oversized sections (> 512 tokens) fall through to token-split with line
number offsets preserved.

### `github-actions-library`

| Field | Value |
|---|---|
| Include patterns | `**/action.yml`, `**/action.yaml`, `README.md` |
| Chunking | `file-level` — entire file is one chunk |
| Description template | `Look up GitHub Actions in {owner}/{repo} — available actions, inputs, outputs, and usage` |

Each `action.yml` is self-contained (name, description, inputs, outputs,
runs). A single-file chunk keeps all fields together for retrieval.

### `cicd-workflows`

| Field | Value |
|---|---|
| Include patterns | `.github/workflows/**` |
| Chunking | `file-level` — entire workflow file is one chunk |
| Description template | `Search CI/CD workflow definitions in {owner}/{repo} — pipelines, jobs, and triggers` |

Workflow files are similar to actions — each file is a coherent unit.
Job-level sub-chunking is deferred to a future slice.

### `openapi-specs`

| Field | Value |
|---|---|
| Include patterns | `**/*.yaml`, `**/*.yml`, `**/*.json`, `openapi/**`, `swagger/**` |
| Chunking | `token-split` |
| Description template | `Search API specs in {owner}/{repo} — endpoints, operations, and schemas` |

Per-endpoint chunking requires a YAML/JSON-aware parser and is deferred.
Token-split still produces useful chunks since OpenAPI paths tend to be
self-contained blocks.

---

## 3. Chunking strategy integration

**`src/ingestion/chunker.ts`** exports `ChunkingStrategy` and accepts it as a
`Partial<ChunkerOptions>` field (defaults to `'token-split'`).

`chunkFile()` dispatches on strategy:

```
'file-level'       → chunkAsWhole()      — one Chunk, lines 1–N
'markdown-heading' → chunkByHeadings()   — one Chunk per # section
'token-split'      → chunkByTokens()     — existing greedy algorithm
```

`chunkByHeadings` collects sections by walking lines. When a section exceeds
`maxTokens` it is sub-chunked via `chunkByTokens(content, lineOffset)` so
output line numbers remain accurate relative to the original file.

**`src/ingestion/pipeline.ts`** — two sites (`tryDeltaSync`, `fullReindex`)
now look up the preset before constructing `Chunker`:

```typescript
const preset = REPO_TYPE_PRESETS[ds.type ?? 'general'];
const chunker = new Chunker({ strategy: preset.chunkingStrategy, ... });
```

The `?? 'general'` guard keeps the pipeline safe for any data source that
somehow lacks a type (defensive, shouldn't happen post-migration).

---

## 4. Wizard step change

The type-selection step is inserted after branch selection and before include
patterns, making the include patterns input immediately useful by pre-populating
it from the preset.

**New step order:**

1. API key check *(unchanged)*
2. Repo URL / browse *(unchanged)*
3. Resolve repo metadata *(unchanged)*
4. Branch *(unchanged)*
5. **Repo type** ← new — QuickPick with 5 options
6. Include patterns — `value` pre-filled from preset
7. Sync schedule *(unchanged)*
8. Tool name *(unchanged)*
9. Tool description — `value` from `preset.toolDescriptionTemplate(owner, repo)`

The description template replaces the old `metadata.description`-based
default. For a `general` repo this produces the same kind of string; for
typed repos it is more specific.

---

## 5. Sampling note

The spec references a "sampling step" where Copilot reads files to generate
the tool description. No such mechanism exists in the current wizard (the
description is a plain text `showInputBox`). The preset's
`toolDescriptionTemplate` achieves the same goal without a live API call —
each type produces a purpose-specific default that the user can refine before
confirming.

---

## 6. Schema and backward compatibility

`DataSourceConfig.type` is a required field in TypeScript. On disk it may be
absent for data sources created before this feature. `configManager.ts` migrates
these at load time:

```typescript
for (const ds of config.dataSources) {
  if (!ds.type) ds.type = 'general';
}
```

No version bump on the config format — the migration is safe to apply
repeatedly and produces no observable change for existing `general` sources.

`ShareableDataSource.type` is optional (`type?: DataSourceType`) so exported
shareable configs from older versions remain valid. `workspaceConfig.ts`
imports with `sds.type ?? 'general'`.

---

## 7. Edge cases

- **Oversized heading sections**: handled by sub-chunking with token-split.
  Line numbers in the output are always relative to the original file.
- **Files with no headings** (documentation type): the entire file becomes
  one section and is token-split if needed — no special case required.
- **Binary/large files with openapi type**: the `.json`/`.yaml` include
  patterns are broad. `GitHubFetcher.fetchFiles()` already skips files over
  1 MB and known binary extensions, so no extra guard is needed.
- **Changing type after initial setup**: out of scope per the spec. Changing
  type requires removing and re-adding the data source, which triggers a
  full re-index with the new chunking strategy.
