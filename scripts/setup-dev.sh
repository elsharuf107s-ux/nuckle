#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in python3 git curl ffmpeg ffprobe node npm; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
# The upstream project pins Playwright and intentionally ignores package-lock.json.
npm install --ignore-scripts --no-audit --no-fund --cache "${TMPDIR:-/tmp}/redstone-npm-cache"
./setup.sh
