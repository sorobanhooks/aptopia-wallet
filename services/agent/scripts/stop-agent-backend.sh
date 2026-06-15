#!/usr/bin/env bash
#
# Stop the agent backend, whichever way it is running (container or nohup).
#
#   ./scripts/stop-agent-backend.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PID_FILE="$REPO_ROOT/.agent-backend.pid"

log() { printf '[stop-agent-backend] %s\n' "$*"; }

# Container path.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' | grep -qx 'xyra-agent-backend'; then
    log "stopping container"
    docker compose down
  fi
fi

# nohup path.
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    log "stopping nohup process (pid $pid)"
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi
pkill -f "$REPO_ROOT/node_modules/.bin/ts-node" 2>/dev/null || true

log "stopped"
