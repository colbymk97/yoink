#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

SOURCE="release"
REPO="colbymk97/yoink"
REPO_DIR="$REPO_ROOT"
EXTENSION_ID="yoink.yoink"
TAG=""
ASSET=""
TARGET=""
ASSUME_YES=0
RELOAD_WINDOW=0
KEEP_ARTIFACTS=1
RUN_NPM_CI=1
INCLUDE_RUNTIME_DEPENDENCIES=1
REBUILD_NATIVE_MODULES=1
ELECTRON_VERSION="39.8.3"
PREPARE_ONLY=0
EXTENSIONS_DIR=""
TMPDIR=""
VSIX_PATH=""
LOCAL_BUILD_VERSION=""

usage() {
  cat <<'EOF'
Usage:
  install-vsix.sh [options]

Modes:
  --source release      Download and install a VSIX from GitHub releases (default)
  --source local-build  Build a local VSIX from this checkout, then install it

Options:
  --repo <owner/name>              GitHub repo for release mode (default: colbymk97/yoink)
  --repo-dir <path>                Checkout path for local-build mode (default: repo root)
  --extension-id <publisher.name>  Extension id to uninstall/install (default: yoink.yoink)
  --extensions-dir <path>          Install into a custom VS Code extensions dir
  --tag <tag>                      Release tag for release mode
  --asset <filename>               Exact asset name for release mode
  --target <target>                VSIX target, e.g. darwin-arm64, linux-x64, win32-x64
  --electron-version <version>     Electron version for local native rebuild (default: 39.8.3)
  --skip-npm-ci                    Local-build mode only: skip npm ci
  --no-runtime-dependencies        Local-build mode only: package with --no-dependencies
  --no-rebuild-native-modules      Local-build mode only: skip electron-rebuild
  --prepare-only                   Fetch/build the VSIX but do not install it
  --cleanup                        Remove the downloaded/built VSIX on exit
  --yes                            Skip interactive confirmation
  --reload-window                  Attempt best-effort VS Code reload after install
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
    --extension-id)
      EXTENSION_ID="$2"
      shift 2
      ;;
    --extensions-dir)
      EXTENSIONS_DIR="$2"
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
    --electron-version)
      ELECTRON_VERSION="$2"
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
    --prepare-only)
      PREPARE_ONLY=1
      shift
      ;;
    --cleanup)
      KEEP_ARTIFACTS=0
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --reload-window)
      RELOAD_WINDOW=1
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

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64) echo "darwin-arm64" ;;
    Darwin/x86_64) echo "darwin-x64" ;;
    Linux/x86_64) echo "linux-x64" ;;
    MINGW*/*|MSYS*/*|CYGWIN*/*|Windows_NT/*) echo "win32-x64" ;;
    *)
      echo "Could not infer VSIX target for ${os}/${arch}. Pass --target explicitly." >&2
      exit 1
      ;;
  esac
}

if [[ -z "$TARGET" ]]; then
  TARGET="$(detect_target)"
fi

arch_from_target() {
  case "$1" in
    *-arm64) echo "arm64" ;;
    *-x64) echo "x64" ;;
    *)
      echo "Could not infer architecture from target: $1" >&2
      exit 1
      ;;
  esac
}

cleanup() {
  if [[ -n "$TMPDIR" && -d "$TMPDIR" && "$KEEP_ARTIFACTS" -eq 0 ]]; then
    rm -rf "$TMPDIR"
  fi
}
trap cleanup EXIT

ensure_tmpdir() {
  if [[ -z "$TMPDIR" ]]; then
    TMPDIR="$(mktemp -d)"
  fi
}

release_view_json() {
  gh release view "$TAG" --repo "$REPO" --json tagName,name,isPrerelease,publishedAt,url,assets
}

recommend_asset_from_release() {
  local release_json suffix
  release_json="$1"
  suffix="${TARGET}.vsix"
  RELEASE_JSON="$release_json" python3 - "$suffix" <<'PY'
import json, os, sys
suffix = sys.argv[1]
data = json.loads(os.environ["RELEASE_JSON"])
for asset in data.get("assets", []):
    name = asset.get("name", "")
    if name.endswith(suffix):
        print(name)
        break
PY
}

print_release_summary() {
  local release_json="$1"
  RELEASE_JSON="$release_json" TARGET_NAME="$TARGET" python3 - <<'PY'
import json, os
data = json.loads(os.environ["RELEASE_JSON"])
print("Source mode: release")
print(f"Release:     {data['tagName']}")
print(f"Name:        {data.get('name') or data['tagName']}")
print(f"URL:         {data['url']}")
print(f"Target:      {os.environ['TARGET_NAME']}")
print("Assets:")
for idx, asset in enumerate(data.get("assets", []), start=1):
    print(f"  {idx}. {asset['name']} ({asset['size']} bytes)")
PY
}

select_release_asset() {
  local release_json="$1" recommended_asset="$2"

  if [[ -n "$ASSET" ]]; then
    return
  fi

  if [[ "$ASSUME_YES" -eq 1 ]]; then
    ASSET="$recommended_asset"
    if [[ -z "$ASSET" ]]; then
      ASSET="$(RELEASE_JSON="$release_json" python3 - <<'PY'
import json, os
data = json.loads(os.environ["RELEASE_JSON"])
assets = data.get("assets", [])
if not assets:
    raise SystemExit("Release has no downloadable assets")
print(assets[0]["name"])
PY
)"
    fi
    return
  fi

  local default_choice="1"
  if [[ -n "$recommended_asset" ]]; then
    default_choice="$(RELEASE_JSON="$release_json" python3 - "$recommended_asset" <<'PY'
import json, os, sys
target = sys.argv[1]
data = json.loads(os.environ["RELEASE_JSON"])
for idx, asset in enumerate(data.get("assets", []), start=1):
    if asset.get("name") == target:
        print(idx)
        break
else:
    print(1)
PY
)"
  fi

  read -r -p "Select asset number to install [${default_choice}]: " choice
  choice="${choice:-$default_choice}"
  ASSET="$(RELEASE_JSON="$release_json" python3 - "$choice" <<'PY'
import json, os, sys
choice = int(sys.argv[1])
data = json.loads(os.environ["RELEASE_JSON"])
assets = data.get("assets", [])
if choice < 1 or choice > len(assets):
    raise SystemExit("Invalid asset choice")
print(assets[choice - 1]["name"])
PY
)"
}

prepare_release_vsix() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI is required for release mode." >&2
    exit 1
  fi

  if [[ -z "$TAG" ]]; then
    TAG="$(gh release list --repo "$REPO" --exclude-drafts --limit 1 --json tagName --jq '.[0].tagName')"
  fi

  if [[ -z "$TAG" || "$TAG" == "null" ]]; then
    echo "Could not determine a release tag for $REPO." >&2
    exit 1
  fi

  local release_json recommended_asset
  release_json="$(release_view_json)"
  print_release_summary "$release_json"
  recommended_asset="$(recommend_asset_from_release "$release_json" || true)"
  if [[ -n "$recommended_asset" ]]; then
    echo "Recommended asset for this machine: $recommended_asset"
  fi

  select_release_asset "$release_json" "$recommended_asset"
  if [[ -z "$ASSET" ]]; then
    echo "Could not resolve an asset to install." >&2
    exit 1
  fi

  if [[ "$ASSUME_YES" -ne 1 ]]; then
    read -r -p "Use ${ASSET} from ${TAG}? [y/N]: " confirm
    case "$confirm" in
      y|Y|yes|YES) ;;
      *)
        echo "Aborted."
        exit 0
        ;;
    esac
  fi

  ensure_tmpdir
  echo "Downloading ${ASSET} from ${TAG}..."
  gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --dir "$TMPDIR" --clobber
  VSIX_PATH="$TMPDIR/$ASSET"
}

print_local_build_summary() {
  cat <<EOF
Source mode: local-build
Repo dir:     ${REPO_DIR}
Target:       ${TARGET}
Electron:     ${ELECTRON_VERSION}
npm ci:       $( [[ "$RUN_NPM_CI" -eq 1 ]] && echo yes || echo no )
Rebuild ABI:  $( [[ "$REBUILD_NATIVE_MODULES" -eq 1 ]] && echo yes || echo no )
Deps in VSIX: $( [[ "$INCLUDE_RUNTIME_DEPENDENCIES" -eq 1 ]] && echo yes || echo no )
EOF
}

prepare_local_build_vsix() {
  if [[ ! -f "${REPO_DIR}/package.json" ]]; then
    echo "No package.json found in repo dir: ${REPO_DIR}" >&2
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required for local-build mode." >&2
    exit 1
  fi

  print_local_build_summary
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    read -r -p "Build a local VSIX with these settings? [y/N]: " confirm
    case "$confirm" in
      y|Y|yes|YES) ;;
      *)
        echo "Aborted."
        exit 0
        ;;
    esac
  fi

  if [[ "$RUN_NPM_CI" -eq 1 ]]; then
    echo "Running npm ci..."
    (cd "$REPO_DIR" && npm ci)
  fi

  if [[ "$INCLUDE_RUNTIME_DEPENDENCIES" -eq 1 ]]; then
    echo "Ensuring sqlite-vec package for ${TARGET}..."
    (cd "$REPO_DIR" && node scripts/ensure-sqlite-vec-target.mjs --target "$TARGET")
  fi

  if [[ "$REBUILD_NATIVE_MODULES" -eq 1 ]]; then
    echo "Rebuilding native modules for Electron ${ELECTRON_VERSION}..."
    (
      cd "$REPO_DIR"
      npx electron-rebuild \
        --module-dir . \
        --version "$ELECTRON_VERSION" \
        --arch "$(arch_from_target "$TARGET")" \
        --force \
        --only better-sqlite3
    )
  fi

  echo "Running npm run build..."
  (cd "$REPO_DIR" && npm run build)

  ensure_tmpdir
  local package_name package_version
  package_name="$(cd "$REPO_DIR" && node -p "require('./package.json').name")"
  package_version="$(cd "$REPO_DIR" && node -p "require('./package.json').version")"
  LOCAL_BUILD_VERSION="$package_version"
  VSIX_PATH="$TMPDIR/${package_name}-${package_version}-${TARGET}.vsix"

  echo "Packaging local VSIX..."
  (
    cd "$REPO_DIR"
    ARGS=(--target "$TARGET" --out "$VSIX_PATH")
    if [[ "$INCLUDE_RUNTIME_DEPENDENCIES" -ne 1 ]]; then
      ARGS=(--no-dependencies "${ARGS[@]}")
    fi
    npx vsce package "${ARGS[@]}"
  )
}

verify_vsix_exists() {
  if [[ -z "$VSIX_PATH" || ! -f "$VSIX_PATH" ]]; then
    echo "Expected VSIX was not found: ${VSIX_PATH}" >&2
    exit 1
  fi
}

code_args() {
  if [[ -n "$EXTENSIONS_DIR" ]]; then
    printf -- "--extensions-dir\0%s\0" "$EXTENSIONS_DIR"
  fi
}

install_vsix() {
  local current_install installed_after expected_version
  local -a code_extra_args=()

  if [[ -n "$EXTENSIONS_DIR" ]]; then
    mkdir -p "$EXTENSIONS_DIR"
    while IFS= read -r -d '' arg; do
      code_extra_args+=("$arg")
    done < <(code_args)
  fi

  current_install="$("$CODE_BIN" "${code_extra_args[@]}" --list-extensions --show-versions | rg "^${EXTENSION_ID}@" || true)"
  if [[ -n "$current_install" ]]; then
    echo "Currently installed: ${current_install}"
    echo "Uninstalling ${EXTENSION_ID}..."
    "$CODE_BIN" "${code_extra_args[@]}" --uninstall-extension "$EXTENSION_ID"
  else
    echo "No existing ${EXTENSION_ID} install found."
  fi

  echo "Installing ${VSIX_PATH}..."
  "$CODE_BIN" "${code_extra_args[@]}" --install-extension "$VSIX_PATH" --force

  installed_after="$("$CODE_BIN" "${code_extra_args[@]}" --list-extensions --show-versions | rg "^${EXTENSION_ID}@" || true)"
  echo "Installed extension versions:"
  echo "$installed_after"

  if [[ "$SOURCE" == "release" ]]; then
    expected_version="${TAG#v}"
  else
    expected_version="$LOCAL_BUILD_VERSION"
  fi

  if [[ -n "$installed_after" && "$installed_after" != *"@${expected_version}" ]]; then
    echo "Note: installed extension version does not match the expected version string."
    echo "      Expected: ${expected_version}"
    echo "      Reported: ${installed_after}"
    echo "      This usually means the packaged extension manifest version was not bumped to the same version as the asset/tag."
  fi
}

reload_window_if_requested() {
  if [[ "$RELOAD_WINDOW" -ne 1 ]]; then
    return
  fi

  if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
    echo "Attempting best-effort VS Code window reload via AppleScript..."
    if ! osascript <<'APPLESCRIPT'
tell application "Visual Studio Code"
  activate
end tell
delay 0.5
tell application "System Events"
  keystroke "p" using {command down, shift down}
  delay 0.5
  keystroke "Developer: Reload Window"
  delay 0.3
  key code 36
end tell
APPLESCRIPT
    then
      echo "Reload attempt failed. On macOS this usually means the terminal does not have Accessibility permission."
      echo "Please use 'Developer: Reload Window' manually in VS Code."
    fi
  else
    echo "Reload requested, but no supported scripted reload path is available on this machine."
  fi
}

case "$SOURCE" in
  release)
    prepare_release_vsix
    ;;
  local-build)
    prepare_local_build_vsix
    ;;
  *)
    echo "Unsupported source mode: $SOURCE" >&2
    exit 1
    ;;
esac

verify_vsix_exists

if [[ "$PREPARE_ONLY" -ne 1 ]]; then
  install_vsix
  reload_window_if_requested
fi

echo "Done."
echo "Source mode: ${SOURCE}"
if [[ "$SOURCE" == "release" ]]; then
  echo "Release tag: ${TAG}"
  echo "Asset: ${ASSET}"
else
  echo "Built target: ${TARGET}"
  echo "Repo dir: ${REPO_DIR}"
fi
if [[ -n "$EXTENSIONS_DIR" ]]; then
  echo "Extensions dir: ${EXTENSIONS_DIR}"
fi
echo "VSIX_PATH=${VSIX_PATH}"
if [[ "$KEEP_ARTIFACTS" -eq 1 ]]; then
  echo "Artifact kept on disk."
else
  echo "Artifact will be cleaned up on exit."
fi
