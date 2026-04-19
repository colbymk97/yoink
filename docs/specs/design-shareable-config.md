# Shareable Config — Design Document

## 1. File Schema: `.vscode/yoink.json`

The shareable config is a strict subset of the internal `yoink.json`. It contains only the fields needed to reconstruct data sources and tools on another machine. All runtime state and credentials are stripped.

```jsonc
{
  "$schema": "https://yoink.dev/schema/shareable-config.json",
  "version": 1,
  "dataSources": [
    {
      "repoUrl": "https://github.com/acme/widgets",
      "owner": "acme",
      "repo": "widgets",
      "branch": "main",
      "includePatterns": ["src/**"],
      "excludePatterns": ["**/*.test.ts"],
      "syncSchedule": "onStartup"
    }
  ],
  "tools": [
    {
      "name": "acme-search",
      "description": "Search the Acme widgets codebase for patterns and examples.",
      "dataSources": ["acme/widgets@main"]
    }
  ],
  "defaultExcludePatterns": [
    "**/node_modules/**",
    "**/dist/**"
  ]
}
```

### Field-by-field comparison with internal config

| Internal `DataSourceConfig` field | Shareable? | Rationale |
|---|---|---|
| `id` | No | Generated fresh on import (UUID) |
| `repoUrl` | Yes | Needed to clone/fetch |
| `owner` | Yes | Needed for GitHub API |
| `repo` | Yes | Needed for GitHub API |
| `branch` | Yes | Needed to know what to index |
| `includePatterns` | Yes | Core filtering config |
| `excludePatterns` | Yes | Core filtering config |
| `syncSchedule` | Yes | Team preference |
| `lastSyncedAt` | No | Per-machine runtime state |
| `lastSyncCommitSha` | No | Per-machine runtime state |
| `status` | No | Per-machine runtime state |
| `errorMessage` | No | Per-machine runtime state |

| Internal `ToolConfig` field | Shareable? | Rationale |
|---|---|---|
| `id` | No | Generated fresh on import (UUID) |
| `name` | Yes | Tool identity |
| `description` | Yes | Copilot-facing description |
| `dataSourceIds` | No — replaced with `dataSources` | IDs are local; use `owner/repo@branch` references instead |

### Shareable type definitions

```typescript
interface ShareableDataSource {
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  includePatterns: string[];
  excludePatterns: string[];
  syncSchedule: 'manual' | 'onStartup' | 'daily';
}

interface ShareableTool {
  name: string;
  description: string;
  dataSources: string[];  // "owner/repo@branch" references
}

interface ShareableConfig {
  $schema?: string;
  version: number;
  dataSources: ShareableDataSource[];
  tools: ShareableTool[];
  defaultExcludePatterns?: string[];
}
```

### Key design decisions

**Tool → DataSource references use `owner/repo@branch` strings, not UUIDs.**
Internal `ToolConfig.dataSourceIds` are UUIDs that are meaningless outside the local machine. The shareable format uses human-readable `"acme/widgets@main"` strings. On import, these are resolved to the local UUIDs of matching data sources (which may have been freshly created during the same import).

**`defaultExcludePatterns` is optional.** If omitted, the importer does not touch the user's existing defaults. If present, the importer merges them (union) with the user's existing patterns.

**`$schema` is informational.** It aids editor autocompletion and signals the file's purpose. It does not need to resolve to a real URL in v1 — a comment-like placeholder is fine.

---

## 2. Workspace Detection

### When it runs

Detection runs once during `activate()`, after all core services are initialized. The extension already activates on `onStartupFinished`, so the workspace is fully available.

### Detection logic

```
1. Get workspace folders: vscode.workspace.workspaceFolders
2. For each folder, check if {folder}/.vscode/yoink.json exists (fs.existsSync)
3. If found, parse the file and validate against ShareableConfig schema
4. If valid, show a non-intrusive information message with "Import" and "Not Now" buttons
5. If user clicks Import → run the merge algorithm
6. If user clicks Not Now → do nothing (no persistence of the dismissal)
```

### Implementation location

A new module: `src/config/workspaceConfig.ts`

```typescript
export class WorkspaceConfigDetector {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly dataSourceManager: DataSourceManager,
    private readonly logger: Logger,
  ) {}

  async detectAndPrompt(): Promise<void> { ... }
  async importConfig(shareableConfig: ShareableConfig): Promise<void> { ... }
}
```

Called from `activate()` after all services are wired:

```typescript
const detector = new WorkspaceConfigDetector(configManager, dataSourceManager, logger);
detector.detectAndPrompt();  // fire-and-forget (not awaited)
```

### Multi-root workspaces

If multiple workspace folders contain `.vscode/yoink.json`, detect only the **first** one (primary workspace folder). This avoids conflicting prompts. The user can always import manually via the export/import commands if needed.

### Re-prompt behavior

The notification appears every time the workspace is opened if the file exists and the user hasn't imported it. This is intentional — the feature brief says auto-sync is out of scope, but a lightweight reminder on workspace open is appropriate. If this becomes annoying, a future enhancement could persist a "dismissed for this workspace" flag in `context.workspaceState`.

---

## 3. Merge Algorithm

The merge is **additive and idempotent**: it adds what's missing, skips what already exists, and never removes anything. Running the same import twice produces the same result.

### Data source merge

For each `ShareableDataSource` in the import:

1. **Match check**: find existing local data source where `owner` (case-insensitive) + `repo` (case-insensitive) + `branch` (exact) all match. This reuses the same matching logic as `DataSourceManager.isDuplicate()`.

2. **If no match**: create a new `DataSourceConfig` with a fresh UUID, set `status: 'queued'`, `lastSyncedAt: null`, `lastSyncCommitSha: null`. Enqueue for indexing via `DataSourceManager.add()`.

3. **If match found**: skip silently. The existing local config is authoritative.

### Tool merge

For each `ShareableTool` in the import:

1. **Resolve data source references**: for each `"owner/repo@branch"` string, find the local `DataSourceConfig` with matching owner/repo/branch. Unresolvable references are dropped with a log warning.

2. **Match check**: find existing local tool where `name` (exact match) matches.

3. **If no match**: create a new `ToolConfig` with a fresh UUID and the resolved `dataSourceIds`.

4. **If match found**: skip silently. The existing local config is authoritative.

### Merge order

1. Import all data sources first (creating new ones, skipping duplicates).
2. Then import all tools (so data source references can be resolved).
3. Flush the config and show a summary notification: *"Imported 2 data sources and 1 tool from workspace config. (3 already existed)"*

---

## 4. Export: Stripping Sensitive Values

### What the export command does

1. Read the current `YoinkConfig` from `ConfigManager`.
2. Map each `DataSourceConfig` to a `ShareableDataSource` by keeping only the shareable fields (see table in section 1). All runtime state fields (`id`, `status`, `lastSyncedAt`, `lastSyncCommitSha`, `errorMessage`) are dropped by construction — they simply aren't included in the output type.
3. Map each `ToolConfig` to a `ShareableTool`:
   - Replace `dataSourceIds` (UUIDs) with `"owner/repo@branch"` strings by looking up each ID via `ConfigManager.getDataSource()`.
   - Skip any data source IDs that can't be resolved (orphaned references).
4. Optionally include `defaultExcludePatterns` if they differ from the built-in defaults.
5. Write the result as pretty-printed JSON to `{workspaceFolder}/.vscode/yoink.json`.

### What's inherently excluded

The `yoink.json` config file **never contains secrets**. API keys are stored in VS Code's `SecretStorage` (OS keychain) or come from the `OPENAI_API_KEY` environment variable. GitHub tokens come from VS Code's built-in GitHub authentication provider. Neither appears in `yoink.json` at any point.

So the export doesn't need to actively "strip" secrets — it just needs to avoid introducing any. The shareable schema has no fields for keys or tokens, making accidental inclusion structurally impossible.

### Export target

- If a workspace folder is open, write to `{workspaceFolders[0]}/.vscode/yoink.json`.
- If no workspace is open, show an error: *"Open a workspace folder first to export Yoink config."*
- If the file already exists, prompt: *"Overwrite existing .vscode/yoink.json?"* with Yes/No.
- Create the `.vscode/` directory if it doesn't exist.

---

## 5. Edge Cases and Open Questions

### Resolved edge cases

**Empty config export**: If the user has no data sources or tools, the export still writes a valid file with empty arrays. This is harmless and avoids special-casing.

**Orphaned tool references**: If a tool references a data source ID that no longer exists locally, that reference is silently dropped from the export. The tool is still exported with its remaining valid references.

**Data source with error status**: Exported as normal. The status field is runtime state and isn't included in the shareable format. The importing user gets a fresh `queued` status.

**Import triggers indexing**: When a new data source is imported and created via `DataSourceManager.add()`, it's immediately enqueued for indexing. This means the user needs an API key configured before importing. If they don't have one, `DataSourceManager.add()` will prompt them (existing behavior via `assertApiKeyConfigured()`).

**File encoding**: Always write and read as UTF-8, consistent with VS Code's default.

### Resolved questions

1. **Dismiss persistence**: Re-prompt each time. Simple, no persistence needed.
2. **defaultExcludePatterns**: Only include in export if they differ from built-in defaults.
3. **Manual import command**: Yes — "Yoink: Import Config from Workspace" command added alongside auto-detect.
4. **Tool name collisions**: N/A — idempotent import skips duplicates silently.
5. **Partial import failures**: Keep partial results, report what failed in the summary notification.
