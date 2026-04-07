# RepoLens

Use any GitHub repository as RAG context for Copilot — query codebases, docs, and institutional knowledge without leaving VS Code.

RepoLens indexes GitHub repositories into a local SQLite vector database and exposes them as Copilot Chat tools. Point it at any repo, ask Copilot a question, and it retrieves the most relevant chunks to ground the answer.

## Features

- Index any public or private GitHub repository as a searchable data source
- Vector search via `sqlite-vec` (brute-force KNN, fully local)
- Automatic delta sync — only re-indexes changed files since last sync
- Multiple tools, each scoped to a subset of data sources
- OpenAI-compatible embedding API (defaults to `text-embedding-3-small`)

## Requirements

- VS Code 1.99+
- GitHub Copilot Chat
- An OpenAI API key (or compatible endpoint)

## Setup

1. Install the extension (see [Installing Locally](#installing-locally) or grab a release VSIX from [Releases](../../releases))
2. Run **RepoLens: Set OpenAI API Key** from the command palette
3. Open the RepoLens sidebar and add a repository
4. Wait for indexing to complete, then ask Copilot about it

## Installing Locally

### From a release VSIX

Download the `.vsix` file from the [Releases](../../releases) page, then:

```bash
code --install-extension repolens-0.0.1.vsix
```

Or via the VS Code UI: Extensions panel → `...` menu → **Install from VSIX...**

### Build and install from source

```bash
git clone https://github.com/colbyking/Lens.git
cd Lens
npm install
npm run build
npm run package        # produces repolens-0.0.1.vsix in the project root
code --install-extension repolens-0.0.1.vsix
```

To uninstall:

```bash
code --uninstall-extension repolens.repolens
```

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `repoLens.embedding.provider` | `openai` | Embedding provider |
| `repoLens.embedding.openai.model` | `text-embedding-3-small` | OpenAI embedding model |
| `repoLens.embedding.openai.baseUrl` | `https://api.openai.com/v1` | Base URL (supports compatible proxies) |
| `repoLens.search.topK` | `10` | Chunks returned per query |
| `repoLens.sync.onStartup` | `true` | Auto-sync on VS Code launch |
| `repoLens.log.level` | `info` | Log verbosity (`debug` / `info` / `warn` / `error`) |

## Development

```bash
npm run build          # TypeScript compile → dist/
npm run watch          # Incremental compile on save
npm run lint           # ESLint
npm test               # Vitest unit tests
npm run package        # Build VSIX (runs vsce package)
```

> **Apple Silicon note:** Storage tests (`test/unit/storage/`) crash locally when Node runs as x64 under Rosetta 2 — `sqlite-vec` uses AVX instructions Rosetta doesn't support. These tests pass on native x86_64 / GitHub CI. Embedding tests always pass.

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

The VSIX will be attached to the GitHub release automatically. Download it from the [Releases](../../releases) page to test.

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
