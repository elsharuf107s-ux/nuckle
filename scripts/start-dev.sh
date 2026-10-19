#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out/dev
if [ ! -f assets/world.json ]; then
  echo "Game assets are missing. Run: bash scripts/setup-dev.sh" >&2
  exit 1
fi
if [ -f out/dev/server.pid ]; then
  pid=$(cat out/dev/server.pid)
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Development server already running (PID $pid)."
    exit 0
  fi
fi
nohup python3 scripts/dev-server.py >out/dev/server.log 2>&1 &
pid=$!
echo "$pid" >out/dev/server.pid
for attempt in {1..50}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat out/dev/server.log >&2
    exit 1
  fi
  if curl --silent --fail http://127.0.0.1:5300/assets/world.json >/dev/null; then
    echo "Game server ready on port 5300. Open it from the Codespaces Ports tab."
    exit 0
  fi
  sleep 0.2
done
echo "Server readiness timed out; see out/dev/server.log" >&2
exit 1
