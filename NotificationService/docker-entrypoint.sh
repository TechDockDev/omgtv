#!/bin/sh
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must be set" >&2
  exit 1
fi

MIGRATION_DIR="./prisma/migrations"
if ls "${MIGRATION_DIR}"/*/migration.sql 2>/dev/null | grep -q .; then
  echo "Running Prisma migrations..."
  npx prisma migrate deploy --schema="prisma/schema.prisma"
else
  echo "No migration files found — skipping migrate deploy"
fi

exec node dist/server.js
