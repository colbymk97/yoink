# Get File Tool — Design Document

## 1. Where registration lives

The feature follows the same three-layer pattern as `yoink-search`.

**`src/tools/getFileTool.ts`**
Exports a `GET_FILE_TOOL` constant (name, displayName, description, inputSchema),
mirroring `globalSearchTool.ts`. Single source of truth for the tool's identity;
`package.json` and `ToolManager` both reference the same name string.

**`src/tools/toolHandler.ts`**
New public method `handleGetFile()` added to the existing `ToolHandler` class.
`GitHubFetcher` is added as a constructor parameter. `extension.ts` already holds
`fetcher` and passes it at construction time.

**`src/tools/toolManager.ts`**
New private method `registerGetFileTool()`, called from `registerAll()` alongside
`registerGlobalSearchTool()`. Stored under the key `'__getfile__'` in
`registeredTools`. Registration is static (global, always-on) — no per-tool
config entry needed.

**`package.json`**
New entry appended to `contributes.languageModelTools`.

**`src/extension.ts`**
Pass `fetcher` as a new argument to the `ToolHandler` constructor.

---

## 2. How the repository input maps to the GitHub client and branch

The input parameter is named `repository` and accepts `owner/repo` format,
matching what `ContextBuilder.format()` already surfaces to the model in search
results. The spec's UUID `repoId` was not adopted — the model has no UUID from
search output.

Resolution:

```typescript
const ds = configManager.getDataSources()
  .find(ds => `${ds.owner}/${ds.repo}`.toLowerCase() === input.repository.toLowerCase());
```

`DataSourceConfig.branch` provides the branch. `GitHubFetcher` carries the
authenticated token in its `getToken` closure — one fetcher instance handles
all repos.

**New method on `GitHubFetcher`: `getFileContents()`**

`getBlob()` requires a SHA. The Contents API accepts a path + branch ref:

```
GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
Accept: application/vnd.github.raw+json
```

Path segments are each `encodeURIComponent`-encoded; slashes are preserved.
Rate limit tracking follows the same `updateRateLimit()` / `waitForRateLimit()`
pattern already in `GitHubFetcher`.

---

## 3. Response format

```
**owner/repo** · Branch: `main` · `src/path/to/file.ts`
Lines 1–320 of 320

```ts
... file content ...
```
```

- Header gives repo, branch, and path — everything needed to cite the source
- `Lines X–Y of N` tells the model the exact range received and total file size
- Language hint inferred from file extension for the fenced code block
- When the full file fits within limits, `Lines 1–N of N` with no truncation notice

---

## 4. Large file truncation

- Default limits: **3,000 lines** or **80,000 characters**, whichever is hit first
- **No range given, file exceeds limit:** return lines 1–N, append a plain-text
  notice after the code block:
  ```
  [File truncated — showing lines 1–3000 of 8400. Call again with startLine/endLine to fetch a specific range.]
  ```
- **Range given (`startLine`/`endLine`):** slice to exactly that range, no
  truncation applied, no notice appended
- All line numbers in the response are 1-indexed actual file line numbers

---

## 5. Error handling

All errors return as `LanguageModelTextPart` text inside a
`LanguageModelToolResult`, matching the catch-and-return pattern in
`executeSearch()`. The model can reason about every case.

| Condition | Text returned to model |
|---|---|
| `repository` not matched | `Repository "owner/repo" is not indexed. Indexed repositories: a/b, c/d` |
| GitHub 404 | `File "src/foo.ts" was not found in owner/repo on branch "main". The path may have changed since the last index.` |
| GitHub 401/403 | `Cannot access owner/repo: insufficient token permissions.` |
| Rate limit | Reused from `waitForRateLimit()`: `GitHub API rate limit exceeded. Try again after {ISO timestamp}.` |
| Any other error | `Get File failed: {err.message}` |

---

## 6. Edge cases

- **Binary files:** No extension check at fetch time. If the GitHub API returns
  binary content, the model receives raw bytes in a code block. This is
  acceptable for v1 — the model will recognise the output as non-text.
- **Status guard:** No `status === 'ready'` check applied. Content is fetched
  live from GitHub regardless of index state; the repo's `{ owner, repo, branch }`
  is all that's needed.
- **Invalid line range:** If `startLine > endLine` or the range exceeds the file,
  the slice returns an empty or partial result. No validation error — the response
  naturally communicates what was returned via the `Lines X–Y of N` header.
