#!/usr/bin/env bash
# dev-install.sh — build, install, and launch a fresh VS Code window with RepoLens active

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find the 'code' binary — prefer PATH, fall back to known macOS app locations
if command -v code &>/dev/null; then
  CODE=code
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
elif [ -x "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE="$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
else
  echo "ERROR: Could not find the 'code' CLI."
  echo "Fix: Open VS Code → Command Palette → 'Shell Command: Install code command in PATH'"
  exit 1
fi

cd "$ROOT"

echo "==> Building..."
npm run build

# On Apple Silicon Macs, the user's Node may be x64 (Rosetta) while VS Code runs
# as arm64.  Native modules (better-sqlite3, sqlite-vec) must match VS Code's arch.
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  NODE_ARCH=$(node -p "process.arch")
  if [[ "$NODE_ARCH" == "x64" ]]; then
    echo "==> Detected x64 Node on arm64 Mac — rebuilding native modules for arm64..."

    # Re-fetch the arm64 prebuilt binary for better-sqlite3
    cd node_modules/better-sqlite3
    npx prebuild-install -r napi --arch arm64 || node-gyp rebuild --release --arch=arm64
    cd "$ROOT"

    # Ensure the arm64 sqlite-vec optional dependency is present
    npm install --no-save sqlite-vec-darwin-arm64 2>/dev/null || true
  fi
fi

echo "==> Packaging VSIX..."
npx vsce package --no-dependencies --out repolens-dev.vsix

echo "==> Installing extension..."
"$CODE" --install-extension repolens-dev.vsix --force

echo "==> Opening new VS Code window..."
"$CODE" --new-window .

echo ""
echo "Done. To view logs:"
echo "  VS Code → View → Output → select 'RepoLens' from the dropdown"
echo "  Or set repoLens.log.level to 'debug' in settings for verbose output"
