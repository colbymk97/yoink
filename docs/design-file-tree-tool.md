# Design: `yoink-file-tree` Tool

## Problem

Agents using Yoink have no structural view of an indexed repository. They must infer layout from semantic search results, which misses files that weren't retrieved and gives no sense of hierarchy. For large repos (monorepos, actions libraries, documentation sites) this creates unnecessary back-and-forth before an agent can start useful work.

## Solution

A deterministic, filterable file-tree tool: given an indexed repo, return a directory/file hierarchy derived entirely from the already-indexed `chunks` table. No LLM calls, no GitHub API round-trips at query time, stable ordering on every call.

## Tool: `yoink-file-tree`

### Input

| Parameter    | Type       | Default | Description |
|--------------|------------|---------|-------------|
| `repository` | `string`   | —       | Required. `owner/repo` format. |
| `path`       | `string`   | repo root | Subtree root to scope output (e.g. `src/`). |
| `maxDepth`   | `number`   | `5`     | Max directory depth to expand (capped at 10). |
| `include`    | `string[]` | —       | Glob patterns to include (applied to full paths). |
| `exclude`    | `string[]` | —       | Glob patterns to exclude. |
| `page`       | `number`   | `1`     | 1-indexed page for large trees. |
| `pageSize`   | `number`   | `200`   | Lines per page (capped at 500). |

### Output

Indented ASCII tree, one line per node, with annotations:

```
acme/platform@main — 127 files, 89,432 tokens
Page 1/1

src/ [dir, 62 files]
  index.ts [ts, 234 tokens]
  api/ [dir, 18 files]
    routes.ts [ts, 1,203 tokens]
    middleware.ts [ts, 876 tokens]
.github/ [dir, 8 files]
  workflows/ [dir, 6 files]
    ci.yml [yaml, 432 tokens, workflow]
docs/ [dir, 5 files]
  README.md [md, 1,890 tokens, docs]
package.json [json, 178 tokens, config]
```

### File flags

Flags are detected from path patterns — no configuration needed:

| Flag       | Heuristic |
|------------|-----------|
| `test`     | Path contains `test/`, `spec/`, `__tests__/`, or filename contains `.test.`/`.spec.` |
| `docs`     | Extension is `.md`/`.mdx`, or path contains `docs/` or `wiki/` |
| `workflow` | Path matches `.github/workflows/**` |
| `action`   | Filename is `action.yml` or `action.yaml` |
| `config`   | Common config filenames (`package.json`, `*.config.*`, `.eslintrc*`, `Makefile`, `Dockerfile`, etc.) |

## Implementation

### Data source

`ChunkStore.getFileStats(dataSourceId)` — already exists, returns `{ filePath, chunkCount, tokenCount }` for every distinct indexed file. No schema changes required.

### New files

- **`src/tools/fileTreeTool.ts`** — tool metadata and input schema (follows `getFileTool.ts` pattern)
- **`src/tools/fileTreeBuilder.ts`** — pure tree-building logic: filter → build → sort → flatten → paginate → format

### Modified files

- **`src/tools/toolHandler.ts`** — `handleFileTree()` method added
- **`src/tools/toolManager.ts`** — `registerFileTreeTool()` added, reserved key `__file-tree__`

### Dependencies

- `minimatch` — already in `package.json` at `^10.0.1`; used the same way as `src/ingestion/fileFilter.ts`
- `detectLanguage` — reused from `src/ingestion/languageDetection.ts`

## Guarantees

- **No LLM calls** — pure data transformation from SQLite
- **Stable ordering** — dirs before files, alphabetical within each group
- **Reproducible output** — same inputs always produce the same output
- **Scope honesty** — only shows files that were actually indexed (respects the data source's include/exclude patterns)

## Testing

Unit tests: `test/unit/tools/fileTreeBuilder.test.ts`

Covers: basic tree rendering, dir-before-file ordering, flag detection (test/docs/workflow/action/config), `rootPath` scoping, `maxDepth` truncation, include/exclude glob filtering, pagination (page 1, page 2, clamp to last page), empty result, parameter capping.
