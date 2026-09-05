#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

vsix="$root/tabthrough-0.0.0.vsix"

if ! command -v cursor >/dev/null; then
  echo "cursor CLI not found on PATH" >&2
  exit 1
fi

if command -v mise >/dev/null; then
  mise exec node@24 -- pnpm ext:package
else
  echo "mise not found; packaging with current node ($(node -v))" >&2
  pnpm ext:package
fi

cursor --install-extension "$vsix" --force
echo "Installed $vsix into Cursor (reload the window if it was already open)."
