You are helping a developer diagnose and fix a failing GitHub Actions CI run in this repository.

## Input

The user may have provided a run ID or GitHub Actions URL: $ARGUMENTS

---

## Step 1 — Identify the failing run

**If `$ARGUMENTS` is non-empty**, extract the numeric run ID:
```bash
echo "$ARGUMENTS" | grep -oE '[0-9]{8,}'
```

**If no run ID was provided**, list recent failed runs:
```bash
gh run list --json databaseId,name,conclusion,headBranch,displayTitle,createdAt --limit 20
```
Filter to entries where `conclusion` is `"failure"`. Present a numbered list (up to 5) showing: run name, branch, and time since it ran. Ask the user to pick one, or proceed automatically with the most recent failure on the current branch.

---

## Step 2 — Fetch failure details

Get job-level metadata:
```bash
gh run view <id> --json jobs,status,conclusion,name,headBranch,headSha,url
```

Then fetch the logs, but **skip the runner/setup boilerplate** — scroll past everything before the actual test or lint output. The signal is in lines containing `FAIL`, `AssertionError`, `Expected`, `Received`, `error TS`, `✖`, or `##[error]`. Pipe through grep to reduce noise:
```bash
gh run view <id> --log-failed 2>&1 | grep -A 20 "FAIL\|AssertionError\|error TS\|✖\|##\[error\]" | grep -v "^[A-Za-z]*[[:space:]]*UNKNOWN STEP[[:space:]]*[0-9T:Z.]*[[:space:]]*\(##\|Received\|Temporarily\|Download\|Syncing\|Running\|npm warn\|added \|Cache\)"
```

If the output is still noisy, fetch the raw log and jump straight to the "Failed Tests" section:
```bash
gh run view <id> --log-failed 2>&1 | grep -A 30 "Failed Tests\|⎯ FAIL\|✖ [0-9]"
```

---

## Step 3 — Diagnose

Identify the root cause from the log. Look for:
- TypeScript errors: `error TS…` — file path and line number
- ESLint violations: rule name, file, line
- Test failures: test name + assertion diff (`Expected` / `Received`)
- Build errors: esbuild, native module compilation

Present a clear summary to the user before touching any files:
- Which jobs failed
- Which files are implicated
- What the fix will be

Do not start editing until the user has seen the diagnosis.

---

## Step 4 — Fix the issues

Use file editing tools to fix the source files. Stay focused — only change what is needed to make the failing check pass. Do not refactor unrelated code.

### Verify locally before committing

After making changes, run the cheapest verification you can before pushing:

```bash
# Always: check lint
npm run lint

# If TypeScript files changed: type check
npm run compile

# Run the specific failing test file if possible (faster than full suite)
npx vitest run <path/to/failing.test.ts>

# Or run the full test suite
npm test
```

**Only commit if local verification passes.** If a test can't run locally (e.g., due to native module constraints noted in CLAUDE.md), say so explicitly — but still run lint and compile.

---

## Step 5 — Check whether a push will trigger CI

Before pushing, read the CI workflow's trigger config:
```bash
grep -A 10 "^on:" .github/workflows/ci.yml
```

**If the current branch matches the `on.push.branches` filter**: pushing will trigger CI directly.

**If it does not match** (e.g., CI only fires on `main` and `claude/**` but you're on a feature branch): push first, then open a PR — CI fires on `pull_request` to `main`.

```bash
# Push
git add <specific files>
git commit -m "fix: <brief description of what was broken>"
git push

# Open PR if needed (skip if branch already has one)
gh pr create --title "fix: <title>" --body "<body>"
```

---

## Step 6 — Wait for the new run to appear

After pushing, poll until a new run appears. Use the push timestamp to distinguish it from old runs:

```bash
PUSH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
until gh run list --branch <headBranch> --limit 5 --json databaseId,createdAt,status,name \
  | python3 -c "
import json, sys
runs = json.load(sys.stdin)
new = [r for r in runs if r['createdAt'] > '$PUSH_TIME']
print(new[0]['databaseId'] if new else '')
" | grep -q '[0-9]'; do
  sleep 5
done
```

Once the run ID is found, watch it with a 15-minute wall-clock timeout so a stuck runner queue doesn't block forever:

```bash
timeout 900 gh run watch <new-run-id> --exit-status; echo "watch_exit:$?"
```

If `watch_exit` is `124` (timeout), the run is still queued or running — report the current status and URL to the user rather than waiting longer.

---

## Step 7 — Report outcome

Fetch the final run status:
```bash
gh run view <new-run-id> --json jobs,conclusion,url
```

- **All jobs green**: confirm the fix worked and share the run URL.
- **Still failing**: fetch new failure logs with `gh run view <new-id> --log-failed` filtered as in Step 2, then return to Step 3 and continue fixing.
- **Timed out waiting**: share the run URL and tell the user the runner queue is slow — they can monitor it directly.
