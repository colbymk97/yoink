---
name: yoink-isolated-vscode-loop
description: Use when you need to reproduce Yoink install and activation issues in normal VS Code with a clean, isolated profile. Builds or fetches a VSIX, installs it into an isolated extensions directory, launches a fresh VS Code window, and captures the session log paths and a grep summary for iteration.
---

# Yoink Isolated VS Code Loop

Use this skill when the goal is to reproduce and iterate on installed-extension failures without using the extension development host.

## Workflow

1. Use the helper at [scripts/run-isolated-vscode.sh](scripts/run-isolated-vscode.sh).
2. Default to `--source local-build` for iteration, because it is the fastest path from a code change to a repro outside the extension host.
3. The script installs Yoink into a fresh `--extensions-dir` and launches VS Code with a fresh `--user-data-dir`, so each run is isolated.
4. The script then waits for the session log directory to appear, writes a grep summary, and prints the exact paths for:
   - run root
   - user data dir
   - extensions dir
   - latest VS Code log dir
   - log summary file
   - installed VSIX path
5. Use the generated log summary first. If needed, inspect the raw files under the printed log dir.
6. For startup or activation failures, this is usually enough to self-iterate entirely from logs.
7. For command-triggered failures, you still need the exact command id or click path. If UI interaction becomes necessary, use Computer Use or add a repo-local automation step later.

## Recommended commands

Run the default local-build loop with a clean profile:

```bash
bash .codex/skills/yoink-isolated-vscode-loop/scripts/run-isolated-vscode.sh --yes
```

Run faster local iterations by skipping `npm ci`:

```bash
bash .codex/skills/yoink-isolated-vscode-loop/scripts/run-isolated-vscode.sh --source local-build --skip-npm-ci --yes
```

Validate the latest release asset in an isolated profile:

```bash
bash .codex/skills/yoink-isolated-vscode-loop/scripts/run-isolated-vscode.sh --source release --yes
```

Open a different workspace while testing:

```bash
bash .codex/skills/yoink-isolated-vscode-loop/scripts/run-isolated-vscode.sh --workspace /absolute/path/to/workspace --yes
```

Reuse a known run directory so paths stay stable across attempts:

```bash
bash .codex/skills/yoink-isolated-vscode-loop/scripts/run-isolated-vscode.sh --run-dir /tmp/yoink-debug-run --source local-build --skip-npm-ci --yes
```

## Notes

- This skill is the repo-local foundation for self-iteration on packaged-extension bugs.
- It relies on the sibling `yoink-local-vsix-install` script to fetch or build the VSIX, so there is only one place to update packaging behavior.
- The script launches a real VS Code window. It does not currently drive the UI after launch.
- The log summary is a fast grep, not a full parser. If the failure is subtle, inspect the raw logs under the printed `LOG_DIR`.
