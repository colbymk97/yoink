# Yoink

Use any GitHub repository as RAG context for Copilot — query codebases, docs, and institutional knowledge without leaving VS Code.

Yoink indexes GitHub repositories into a local SQLite vector database and exposes them as Copilot Chat tools. Point it at any repo, ask Copilot a question, and it retrieves the most relevant chunks to ground the answer.

## Features

- Index any public or private GitHub repository as a searchable data source
- Per-file chunking — markdown is split on headings, source code is split on
  functions/methods/classes via Tree-sitter (TS/TSX, JS/JSX, Python, Go, Java,
  C#, Rust, Ruby), `action.yml` and workflow files are kept whole, and
  everything else falls back to fixed-size token windows
- Vector search via `sqlite-vec` (brute-force KNN, fully local)
- Automatic delta sync — only re-indexes changed files since last sync
- Multiple tools, each scoped to a subset of data sources
- OpenAI-compatible embedding API (defaults to `text-embedding-3-small`)

### Repo types

When you add a repository, you pick a type that drives the include filter —
i.e. which files get indexed. The chunking strategy is chosen **per file** by
the chunker based on path/extension, not per data source, so a single
`source-code` data source can mix TypeScript code and Markdown docs and each
file is chunked appropriately.

| Type                       | Indexes                                                                |
|----------------------------|------------------------------------------------------------------------|
| `general`                  | everything (no filter)                                                 |
| `documentation`            | `**/*.md`, `**/*.mdx`, `docs/**`, `wiki/**`                            |
| `source-code`              | TS/TSX, JS/JSX, Python, Go, Java, C#, Rust, Ruby — plus `.md`/`.mdx`   |
| `github-actions-library`   | `action.yml` / `action.yaml` and `README.md` at any depth              |
| `cicd-workflows`           | `.github/workflows/**`                                                 |
| `openapi-specs`            | YAML/JSON spec files, `openapi/**`, `swagger/**`                       |

### Chunking

Strategy is chosen per file:

| File pattern                               | Strategy                                                      |
|--------------------------------------------|---------------------------------------------------------------|
| `*.md`, `*.mdx`                            | split on `#` headings (oversized sections fall back to tokens)|
| `.github/workflows/*.{yml,yaml}`           | one chunk per file                                            |
| `action.yml` / `action.yaml` (any depth)   | one chunk per file                                            |
| Supported source languages (see above)     | one chunk per function / method / class (Tree-sitter AST)     |
| Everything else                            | fixed-size token windows with overlap                         |

AST method chunks are prefixed with their enclosing class (e.g.
`// Class: UserService`) so the embedded text carries context. Parse failures
or files with no definitions fall back to token-split, so polyglot repos
work without manual configuration.

## Requirements

- VS Code 1.99+
- GitHub Copilot Chat
- An OpenAI API key (or compatible endpoint)

## Setup

1. Install the extension (see [Installing Locally](#installing-locally) or grab a release VSIX from [Releases](https://github.com/colbymk97/yoink/releases))
2. Run **Yoink: Set OpenAI API Key** from the command palette
3. Open the Yoink sidebar and add a repository
4. Wait for indexing to complete, then ask Copilot about it

## Installing Locally

### From a release VSIX

Download the `.vsix` file from the [Releases](https://github.com/colbymk97/yoink/releases) page, then:

```bash
code --install-extension yoink-0.0.1.vsix
```

Or via the VS Code UI: Extensions panel → `...` menu → **Install from VSIX...**

### Build and install from source

```bash
git clone https://github.com/colbymk97/yoink.git
cd Lens
npm install
npm run build
npm run package        # produces yoink-0.0.1.vsix in the project root
code --install-extension yoink-0.0.1.vsix
```

To uninstall:

```bash
code --uninstall-extension yoink.yoink
```

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `yoink.embedding.provider` | `openai` | Embedding provider |
| `yoink.embedding.openai.model` | `text-embedding-3-small` | OpenAI embedding model |
| `yoink.embedding.openai.baseUrl` | `https://api.openai.com/v1` | Base URL (supports compatible proxies) |
| `yoink.search.topK` | `10` | Chunks returned per query |
| `yoink.sync.onStartup` | `true` | Auto-sync on VS Code launch |
| `yoink.log.level` | `info` | Log verbosity (`debug` / `info` / `warn` / `error`) |

## Development

```bash
npm run build          # TypeScript compile → dist/
npm run watch          # Incremental compile on save
npm run lint           # ESLint
npm test               # Vitest unit tests
npm run package        # Build VSIX (runs vsce package)
npm run dev:install    # Build, install, and open a new VS Code window
```

> **Apple Silicon note:** Storage tests (`test/unit/storage/`) crash locally when Node runs as x64 under Rosetta 2 — `sqlite-vec` uses AVX instructions Rosetta doesn't support. These tests pass on native x86_64 / GitHub CI. Embedding tests always pass.

### Viewing logs

Yoink writes to a VS Code Output Channel. To open it:

**View → Output**, then select **Yoink** from the dropdown in the top-right of the panel.

To enable verbose logging, set `yoink.log.level` to `"debug"` in your VS Code settings — this surfaces chunking, embedding, and sync details.

## CI and Releases

### Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Push to `main` / `claude/**`, any PR | Lint, test, build + package VSIX |
| `prerelease.yml` | Tag `v*-*` (e.g. `v0.1.0-alpha.1`) | Builds VSIX, publishes GitHub prerelease |
| `release.yml` | Tag `v*` without hyphen (e.g. `v0.1.0`) | Builds VSIX, publishes stable GitHub release |

Build logic (checkout → `npm ci` → `npm run build` → `vsce package`) lives in a shared reusable workflow (`_build.yml`) called by all three.

### Publishing a prerelease

```bash
git tag v0.0.1-alpha.1
git push origin v0.0.1-alpha.1
```

The VSIX will be attached to the GitHub release automatically. Download it from the [Releases](https://github.com/colbymk97/yoink/releases) page to test.

### Publishing a stable release

1. Update `version` in `package.json`
2. Commit and push to `main`
3. Tag and push:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## License

MIT
