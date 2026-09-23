#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
HEALTH_LOG="$LOG_DIR/healthcheck.log"
SERVICE_PORT="${PORT:-4173}"

mkdir -p "$LOG_DIR"

if curl --max-time 5 -fsS "http://127.0.0.1:${SERVICE_PORT}/api/health" 2>/dev/null | grep -q '"ok":true'; then
  exit 0
fi

printf '[%s] Health check failed; restarting AlphaPulse\n' "$(date '+%F %T')" >> "$HEALTH_LOG"
if bash "$SCRIPT_DIR/cloud-service.sh" restart >> "$HEALTH_LOG" 2>&1; then
  printf '[%s] AlphaPulse recovered\n' "$(date '+%F %T')" >> "$HEALTH_LOG"
  exit 0
fi

printf '[%s] AlphaPulse recovery failed\n' "$(date '+%F %T')" >> "$HEALTH_LOG"
exit 1
