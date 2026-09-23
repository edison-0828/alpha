#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_DIR/data"
BACKUP_ROOT="${ALPHAPULSE_BACKUP_DIR:-/workspace/alphapulse-backups}"
RETENTION_DAYS="${ALPHAPULSE_BACKUP_RETENTION_DAYS:-14}"
ALPHAPULSE_NVM_DIR="${ALPHAPULSE_NVM_DIR:-/workspace/.nvm}"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DEST_DIR="$BACKUP_ROOT/$STAMP"

mkdir -p "$DEST_DIR"
unset NPM_CONFIG_PREFIX npm_config_prefix
if [[ -s "$ALPHAPULSE_NVM_DIR/nvm.sh" ]]; then
  export NVM_DIR="$ALPHAPULSE_NVM_DIR"
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm use --delete-prefix 22 >/dev/null
fi

for file in monitor-state.json.gz monitor-state.json paper-portfolio.json; do
  if [[ -f "$DATA_DIR/$file" ]]; then cp -p "$DATA_DIR/$file" "$DEST_DIR/$file"; fi
done

if [[ -f "$DATA_DIR/alphapulse.db" ]]; then
  node --input-type=module - "$DATA_DIR/alphapulse.db" "$DEST_DIR/alphapulse.db" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const [, , source, destination] = process.argv;
const escaped = destination.replaceAll("'", "''");
const database = new DatabaseSync(source, { readOnly:true });
database.exec(`VACUUM INTO '${escaped}'`);
database.close();
NODE
fi

printf 'created_at_utc=%s\nproject=%s\n' "$STAMP" "$PROJECT_DIR" > "$DEST_DIR/manifest.txt"

RESOLVED_BACKUP_ROOT="$(realpath -m "$BACKUP_ROOT")"
case "$RESOLVED_BACKUP_ROOT" in
  /workspace/*)
    find "$RESOLVED_BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -print -exec rm -rf -- {} +
    ;;
  *)
    echo "Skipping retention cleanup outside /workspace: $RESOLVED_BACKUP_ROOT"
    ;;
esac

echo "AlphaPulse backup created at $DEST_DIR"
