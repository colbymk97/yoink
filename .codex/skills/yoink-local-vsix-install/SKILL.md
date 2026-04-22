---
name: yoink-local-vsix-install
description: Use when you need to build or fetch a Yoink VSIX and install it into normal VS Code outside the extension host. Supports either the latest GitHub release asset or a local build that mirrors the release workflow, and can install into the default extensions directory or a custom isolated one.
---

# Yoink Local VSIX Install

Use this skill when the goal is to validate Yoink as an installed VS Code extension rather than in the extension development host.

## Workflow

1. Use the helper at [scripts/install-vsix.sh](scripts/install-vsix.sh).
2. Choose a source mode:
   - `release`: fetch a VSIX from GitHub releases
   - `local-build`: build a VSIX locally with the same core steps as `.github/workflows/_build.yml`
3. Default to repo `colbymk97/yoink`, repo dir at the current repository root, and extension id `yoink.yoink`.
4. In `release` mode, let the script choose the latest non-draft release from `gh release list`, because this repo ships prereleases frequently.
5. In `local-build` mode, the script mirrors the workflow build path:
   - `npm ci`
   - optional `electron-rebuild` for `better-sqlite3`
   - `npm run build`
   - `vsce package --target ... --out ...`
6. Prefer `--prepare-only` when another script needs the VSIX path but will handle install/launch itself.
7. Install globally by default, or pass `--extensions-dir` to install into an isolated VS Code extension directory.
8. Summarize the chosen asset/build settings, the installed version, and any packaging mismatches.

## Recommended commands

Preview the latest release asset and prompt before installing:

```bash
bash .codex/skills/yoink-local-vsix-install/scripts/install-vsix.sh
```

Install the latest release asset for this machine into the default VS Code profile:

```bash
bash .codex/skills/yoink-local-vsix-install/scripts/install-vsix.sh --source release --yes
```

Build a local VSIX with release-like steps and install it:

```bash
bash .codex/skills/yoink-local-vsix-install/scripts/install-vsix.sh --source local-build --yes
```

Build locally but skip `npm ci` for faster iteration:

```bash
bash .codex/skills/yoink-local-vsix-install/scripts/install-vsix.sh --source local-build --skip-npm-ci --yes
```

Prepare a local VSIX without installing it:

```bash
bash .codex/skills/yoink-local-vsix-install/scripts/install-vsix.sh --source local-build --skip-npm-ci --prepare-only --yes
```

Install into a custom isolated extensions directory:

```bash
bash .codex/skills/yoink-local-vsix-install/scripts/install-vsix.sh --source local-build --skip-npm-ci --extensions-dir /tmp/yoink-exts --yes
```

## Notes

- This skill keeps the logic repo-local so future Codex runs do not depend on `~/.codex/skills`.
- `local-build` defaults to `npm ci` because that best matches release packaging. For faster local iteration, use `--skip-npm-ci`.
- The native rebuild mirrors the current workflow and only rebuilds `better-sqlite3`. If CI changes, update this script to match `_build.yml`.
- `code --list-extensions --show-versions` reports the extension manifest version, not the VSIX filename. If a prerelease asset name includes `-alpha.N` but `package.json` still says `0.0.1`, VS Code will still report `yoink.yoink@0.0.1`.
