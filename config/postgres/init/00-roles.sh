#!/bin/bash
# Database roles, created from .env on first initialisation of the primary's volume.
#   monitor: read-only statistics for postgres-exporter (pg_monitor), no table access.
# Task 12 adds app_rw (least-privilege application role) and repl here.
set -euo pipefail

if [ -z "${MONITOR_DB_PASSWORD:-}" ]; then
  echo "00-roles.sh: MONITOR_DB_PASSWORD is empty; run npm run up:<mode> to generate .env" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v monitor_pw="$MONITOR_DB_PASSWORD" <<'SQL'
CREATE ROLE monitor WITH LOGIN PASSWORD :'monitor_pw';
GRANT pg_monitor TO monitor;
SQL
