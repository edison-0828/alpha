#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
RUNNER_PID_FILE="$LOG_DIR/cloud-runner.pid"
SERVICE_PID_FILE="$LOG_DIR/cloud-service.pid"
LEGACY_RUNNER_PID_FILE="$PROJECT_DIR/runner.pid"
RUNNER_LOG="$LOG_DIR/runner.log"
SERVICE_LOG="$LOG_DIR/service.log"
SERVICE_PORT="${PORT:-4173}"
NODE_VERSION="${ALPHAPULSE_NODE_VERSION:-22}"
ALPHAPULSE_NVM_DIR="${ALPHAPULSE_NVM_DIR:-/workspace/.nvm}"

mkdir -p "$LOG_DIR"

pid_alive() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  [[ -s "$file" ]] && tr -dc '0-9' < "$file"
}

health_ok() {
  curl --max-time 4 -fsS "http://127.0.0.1:${SERVICE_PORT}/api/health" 2>/dev/null | grep -q '"ok":true'
}

load_node() {
  unset NPM_CONFIG_PREFIX npm_config_prefix
  if [[ -s "$ALPHAPULSE_NVM_DIR/nvm.sh" ]]; then
    export NVM_DIR="$ALPHAPULSE_NVM_DIR"
    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"
    nvm use --delete-prefix "$NODE_VERSION" >/dev/null
  fi
  command -v node >/dev/null
}

run_loop() {
  load_node
  cd "$PROJECT_DIR"
  local child_pid=""
  cleanup() {
    if pid_alive "$child_pid"; then
      kill "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
    fi
    rm -f "$SERVICE_PID_FILE"
    exit 0
  }
  trap cleanup TERM INT

  while true; do
    printf '[%s] Starting AlphaPulse with %s\n' "$(date '+%F %T')" "$(node --version)" >> "$SERVICE_LOG"
    node --disable-warning=ExperimentalWarning "$PROJECT_DIR/server.js" >> "$SERVICE_LOG" 2>&1 &
    child_pid=$!
    printf '%s\n' "$child_pid" > "$SERVICE_PID_FILE"
    wait "$child_pid"
    local exit_code=$?
    rm -f "$SERVICE_PID_FILE"
    printf '[%s] AlphaPulse exited with code %s; restarting in 5 seconds\n' "$(date '+%F %T')" "$exit_code" >> "$SERVICE_LOG"
    sleep 5
  done
}

stop_service() {
  local runner_pid service_pid legacy_runner_pid
  runner_pid="$(read_pid "$RUNNER_PID_FILE")"
  service_pid="$(read_pid "$SERVICE_PID_FILE")"
  legacy_runner_pid="$(read_pid "$LEGACY_RUNNER_PID_FILE")"

  if pid_alive "$runner_pid"; then kill "$runner_pid" 2>/dev/null || true; fi
  if pid_alive "$service_pid"; then kill "$service_pid" 2>/dev/null || true; fi
  if pid_alive "$legacy_runner_pid"; then kill "$legacy_runner_pid" 2>/dev/null || true; fi

  sleep 1
  if health_ok && command -v fuser >/dev/null; then
    fuser -k -TERM "${SERVICE_PORT}/tcp" >/dev/null 2>&1 || true
  fi

  for _ in 1 2 3 4 5 6 7 8; do
    if ! pid_alive "$runner_pid" && ! pid_alive "$service_pid" && ! pid_alive "$legacy_runner_pid" && ! health_ok; then break; fi
    sleep 1
  done
  if pid_alive "$runner_pid"; then kill -KILL "$runner_pid" 2>/dev/null || true; fi
  if pid_alive "$service_pid"; then kill -KILL "$service_pid" 2>/dev/null || true; fi
  if pid_alive "$legacy_runner_pid"; then kill -KILL "$legacy_runner_pid" 2>/dev/null || true; fi
  rm -f "$RUNNER_PID_FILE" "$SERVICE_PID_FILE" "$LEGACY_RUNNER_PID_FILE"
}

start_service() {
  local runner_pid
  if health_ok; then
    echo "AlphaPulse is already healthy on port $SERVICE_PORT"
    return 0
  fi
  runner_pid="$(read_pid "$RUNNER_PID_FILE")"
  if pid_alive "$runner_pid"; then
    echo "AlphaPulse runner exists but health check failed; use restart"
    return 1
  fi
  nohup bash "$SCRIPT_DIR/cloud-service.sh" run >> "$RUNNER_LOG" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$RUNNER_PID_FILE"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if health_ok; then
      echo "AlphaPulse started successfully on port $SERVICE_PORT"
      return 0
    fi
    sleep 1
  done
  echo "AlphaPulse did not become healthy; inspect $RUNNER_LOG and $SERVICE_LOG"
  return 1
}

status_service() {
  local runner_pid service_pid
  runner_pid="$(read_pid "$RUNNER_PID_FILE")"
  service_pid="$(read_pid "$SERVICE_PID_FILE")"
  echo "runner_pid=${runner_pid:-none} runner_alive=$(pid_alive "$runner_pid" && echo yes || echo no)"
  echo "service_pid=${service_pid:-none} service_alive=$(pid_alive "$service_pid" && echo yes || echo no)"
  curl --max-time 5 -fsS "http://127.0.0.1:${SERVICE_PORT}/api/health"
  echo
}

case "${1:-status}" in
  run) run_loop ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) stop_service; start_service ;;
  status) status_service ;;
  *) echo "Usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
