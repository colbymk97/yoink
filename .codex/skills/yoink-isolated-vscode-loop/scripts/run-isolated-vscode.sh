#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_DIR}/../../.." && pwd)"
INSTALL_SCRIPT="${REPO_ROOT}/.codex/skills/yoink-local-vsix-install/scripts/install-vsix.sh"

SOURCE="local-build"
REPO="colbymk97/yoink"
REPO_DIR="$REPO_ROOT"
WORKSPACE="$REPO_ROOT"
EXTENSION_ID="yoink.yoink"
TARGET=""
TAG=""
ASSET=""
RUN_DIR=""
SETTLE_SECONDS=15
ASSUME_YES=0
COMMAND_TITLE=""
RUN_NPM_CI=1
INCLUDE_RUNTIME_DEPENDENCIES=1
REBUILD_NATIVE_MODULES=1
ELECTRON_VERSION="39.8.3"
LATEST_LOG_DIR=""
SUMMARY_PATH=""
VSIX_PATH=""

usage() {
  cat <<'EOF'
Usage:
  run-isolated-vscode.sh [options]

Options:
  --source <release|local-build>    VSIX source mode (default: local-build)
  --repo <owner/name>               GitHub repo for release mode (default: colbymk97/yoink)
  --repo-dir <path>                 Local checkout for local-build mode (default: repo root)
  --workspace <path>                Folder or workspace to open in VS Code (default: repo root)
  --extension-id <publisher.name>   Extension id to install (default: yoink.yoink)
  --tag <tag>                       Release tag for release mode
  --asset <filename>                Exact release asset for release mode
  --target <target>                 VSIX target, e.g. darwin-arm64
  --run-dir <path>                  Reuse or create an explicit run directory
  --command-title <title>           Run a command palette entry after launch (macOS only)
  --settle-seconds <n>              Wait time after launch before scraping logs (default: 15)
  --skip-npm-ci                     Local-build mode only: skip npm ci
  --no-runtime-dependencies         Local-build mode only: package with --no-dependencies
  --no-rebuild-native-modules       Local-build mode only: skip electron-rebuild
  --electron-version <version>      Electron version for local native rebuild (default: 39.8.3)
  --yes                             Skip interactive confirmation
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    --workspace)
      WORKSPACE="$2"
      shift 2
      ;;
    --extension-id)
      EXTENSION_ID="$2"
      shift 2
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --asset)
      ASSET="$2"
      shift 2
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    --run-dir)
      RUN_DIR="$2"
      shift 2
      ;;
    --command-title)
      COMMAND_TITLE="$2"
      shift 2
      ;;
    --settle-seconds)
      SETTLE_SECONDS="$2"
      shift 2
      ;;
    --skip-npm-ci)
      RUN_NPM_CI=0
      shift
      ;;
    --no-runtime-dependencies)
      INCLUDE_RUNTIME_DEPENDENCIES=0
      shift
      ;;
    --no-rebuild-native-modules)
      REBUILD_NATIVE_MODULES=0
      shift
      ;;
    --electron-version)
      ELECTRON_VERSION="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

find_code_cli() {
  if command -v code >/dev/null 2>&1; then
    command -v code
    return
  fi

  if [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    return
  fi

  if [[ -x "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    echo "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    return
  fi

  echo "VS Code CLI 'code' is required." >&2
  exit 1
}

CODE_BIN="$(find_code_cli)"

if [[ ! -x "$INSTALL_SCRIPT" ]]; then
  echo "Missing install helper: $INSTALL_SCRIPT" >&2
  exit 1
fi

if [[ -z "$RUN_DIR" ]]; then
  RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yoink-vscode-run.XXXXXX")"
else
  mkdir -p "$RUN_DIR"
fi

USER_DATA_DIR="${RUN_DIR}/user-data"
EXTENSIONS_DIR="${RUN_DIR}/extensions"
STDOUT_LOG="${RUN_DIR}/code-stdout.log"
STDERR_LOG="${RUN_DIR}/code-stderr.log"
SUMMARY_PATH="${RUN_DIR}/log-summary.txt"

mkdir -p "$USER_DATA_DIR" "$EXTENSIONS_DIR"

run_install_helper() {
  local -a args
  args=(
    --source "$SOURCE"
    --repo "$REPO"
    --repo-dir "$REPO_DIR"
    --extension-id "$EXTENSION_ID"
    --extensions-dir "$EXTENSIONS_DIR"
    --electron-version "$ELECTRON_VERSION"
  )

  if [[ "$ASSUME_YES" -eq 1 ]]; then
    args+=(--yes)
  fi
  if [[ -n "$TARGET" ]]; then
    args+=(--target "$TARGET")
  fi
  if [[ -n "$TAG" ]]; then
    args+=(--tag "$TAG")
  fi
  if [[ -n "$ASSET" ]]; then
    args+=(--asset "$ASSET")
  fi
  if [[ "$RUN_NPM_CI" -ne 1 ]]; then
    args+=(--skip-npm-ci)
  fi
  if [[ "$INCLUDE_RUNTIME_DEPENDENCIES" -ne 1 ]]; then
    args+=(--no-runtime-dependencies)
  fi
  if [[ "$REBUILD_NATIVE_MODULES" -ne 1 ]]; then
    args+=(--no-rebuild-native-modules)
  fi

  local output
  output="$(bash "$INSTALL_SCRIPT" "${args[@]}")"
  printf '%s\n' "$output"
  VSIX_PATH="$(printf '%s\n' "$output" | sed -n 's/^VSIX_PATH=//p' | tail -n 1)"
}

find_latest_log_dir() {
  local logs_root="$USER_DATA_DIR/logs"
  if [[ ! -d "$logs_root" ]]; then
    return 1
  fi

  find "$logs_root" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort | tail -n 1
}

wait_for_log_dir() {
  local deadline now
  deadline=$(( $(date +%s) + SETTLE_SECONDS + 20 ))
  while true; do
    if LATEST_LOG_DIR="$(find_latest_log_dir)"; then
      if [[ -n "$LATEST_LOG_DIR" ]]; then
        return 0
      fi
    fi
    now="$(date +%s)"
    if (( now >= deadline )); then
      return 1
    fi
    sleep 1
  done
}

write_log_summary() {
  {
    echo "Run dir: ${RUN_DIR}"
    echo "User data dir: ${USER_DATA_DIR}"
    echo "Extensions dir: ${EXTENSIONS_DIR}"
    echo "Workspace: ${WORKSPACE}"
    echo "VSIX path: ${VSIX_PATH}"
    echo "Code stdout: ${STDOUT_LOG}"
    echo "Code stderr: ${STDERR_LOG}"
    echo
    if [[ -z "$LATEST_LOG_DIR" ]]; then
      echo "No VS Code log directory was found."
    else
      echo "Latest log dir: ${LATEST_LOG_DIR}"
      echo
      echo "Files:"
      find "$LATEST_LOG_DIR" -type f | sort
      echo
      echo "Activation matches:"
      rg -n -i --max-columns 240 --max-columns-preview \
        -e 'ExtensionService#_doActivateExtension yoink\.yoink' \
        -e 'Activating extension yoink\.yoink' \
        -e 'yoink\.yoink failed' \
        "$LATEST_LOG_DIR" || true
      echo
      echo "Known runtime clues:"
      rg -n -i --max-columns 240 --max-columns-preview \
        -e 'command was not found' \
        -e 'better-sqlite3' \
        -e 'sqlite-vec' \
        -e 'tiktoken' \
        "$LATEST_LOG_DIR" || true
      echo
      echo "Error lines:"
      rg -n -i --max-columns 240 --max-columns-preview \
        -e '\[error\]' \
        "$LATEST_LOG_DIR" || true
    fi
  } >"$SUMMARY_PATH"
}

run_command_if_requested() {
  if [[ -z "$COMMAND_TITLE" ]]; then
    return
  fi

  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v osascript >/dev/null 2>&1; then
    echo "Command trigger requested, but scripted command execution is only supported on macOS right now."
    return
  fi

  echo "Attempting to run command palette entry: ${COMMAND_TITLE}"
  if ! osascript <<APPLESCRIPT
tell application "Visual Studio Code"
  activate
end tell
delay 0.8
tell application "System Events"
  keystroke "p" using {command down, shift down}
  delay 0.8
  keystroke "${COMMAND_TITLE}"
  delay 0.5
  key code 36
end tell
APPLESCRIPT
  then
    echo "Command trigger failed. On macOS this usually means the terminal does not have Accessibility permission."
  fi
}

if [[ "$ASSUME_YES" -ne 1 ]]; then
  cat <<EOF
Source mode:  ${SOURCE}
Repo dir:     ${REPO_DIR}
Workspace:    ${WORKSPACE}
Run dir:      ${RUN_DIR}
Settle time:  ${SETTLE_SECONDS}s
EOF
  read -r -p "Launch an isolated VS Code run with these settings? [y/N]: " confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *)
      echo "Aborted."
      exit 0
      ;;
  esac
fi

run_install_helper

echo "Launching VS Code..."
"$CODE_BIN" \
  --user-data-dir "$USER_DATA_DIR" \
  --extensions-dir "$EXTENSIONS_DIR" \
  --new-window "$WORKSPACE" \
  --sync off \
  --log trace \
  --log "${EXTENSION_ID}:trace" \
  >"$STDOUT_LOG" 2>"$STDERR_LOG" &

sleep 2
run_command_if_requested

echo "Waiting ${SETTLE_SECONDS}s for the session to settle..."
sleep "$SETTLE_SECONDS"

if wait_for_log_dir; then
  :
else
  LATEST_LOG_DIR=""
fi

write_log_summary

echo "Done."
echo "RUN_DIR=${RUN_DIR}"
echo "USER_DATA_DIR=${USER_DATA_DIR}"
echo "EXTENSIONS_DIR=${EXTENSIONS_DIR}"
echo "LOG_DIR=${LATEST_LOG_DIR}"
echo "LOG_SUMMARY=${SUMMARY_PATH}"
echo "CODE_STDOUT=${STDOUT_LOG}"
echo "CODE_STDERR=${STDERR_LOG}"
echo "VSIX_PATH=${VSIX_PATH}"
