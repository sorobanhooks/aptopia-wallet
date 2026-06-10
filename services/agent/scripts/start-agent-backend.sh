#!/usr/bin/env bash
#
# Start the agent backend, preferring the durable Docker container and falling
# back to a detached nohup process when Docker is unavailable.
#
#   ./scripts/start-agent-backend.sh
#
# Container path:  docker compose up -d --build  (restart=unless-stopped, so it
#                  survives Docker/machine restarts). Any stray nohup process is
#                  stopped first to free port 3000.
# Fallback path:   nohup npm run dev  (logged to agent-backend.nohup.log, PID in
#                  .agent-backend.pid) — used only when Docker is not reachable.
#
# Only one path runs at a time; both bind host port 3000.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-3000}"
HEALTH_URL="http://localhost:${PORT}/health"
PID_FILE="$REPO_ROOT/.agent-backend.pid"
LOG_FILE="$REPO_ROOT/agent-backend.nohup.log"

log()  { printf '[start-agent-backend] %s\n' "$*"; }

wait_for_health() {
  local tries="${1:-60}"
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      log "healthy at $HEALTH_URL"
      return 0
    fi
    sleep 1
  done
  log "ERROR: not healthy at $HEALTH_URL after ${tries}s"
  return 1
}

stop_nohup() {
  # Stop a previously-launched nohup process (by pidfile) plus any stray
  # ts-node/nodemon for this repo, so the container can claim port 3000.
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "stopping nohup process (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # Belt-and-braces: kill any ts-node started from this repo path.
  pkill -f "$REPO_ROOT/node_modules/.bin/ts-node" 2>/dev/null || true
}

docker_available() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  return 0
}

start_container() {
  log "Docker is available — starting durable container"
  stop_nohup
  docker compose up -d --build
  wait_for_health 90
  log "container up (restart=unless-stopped). Logs: docker compose logs -f"
}

start_nohup() {
  log "Docker not available — falling back to nohup process"
  # Already healthy? Leave it.
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "agent backend already responding at $HEALTH_URL — nothing to do"
    return 0
  fi
  if [[ ! -d node_modules ]]; then
    log "installing dependencies (npm ci)"
    npm ci
  fi
  log "launching: nohup npm run dev  (log: $LOG_FILE)"
  nohup npm run dev >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  log "nohup pid $(cat "$PID_FILE")"
  wait_for_health 60
}

if docker_available; then
  start_container
else
  start_nohup
fi
