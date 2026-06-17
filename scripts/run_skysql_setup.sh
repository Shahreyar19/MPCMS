#!/usr/bin/env bash
set -euo pipefail

: "${DB_PASSWORD:?Set DB_PASSWORD before running this script}"

export MYSQL_PWD="$DB_PASSWORD"

mariadb \
  --host serverless-us-central1.sysp0000.db2.skysql.com \
  --port 4016 \
  --user dbpgf37955378 \
  --ssl-verify-server-cert \
  < sql/init_qm_app.sql

unset MYSQL_PWD

echo "Schema setup complete for qm_app."
