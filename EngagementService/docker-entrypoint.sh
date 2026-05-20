#!/bin/sh
set -e

if [ -n "${DATABASE_URL:-}" ]; then
  MIGRATION_DIR="prisma/migrations"
  if ls "${MIGRATION_DIR}"/*/migration.sql 2>/dev/null | grep -q .; then
    echo "Running Prisma migrations..."
    npx prisma migrate deploy --schema="prisma/schema.prisma"
  else
    echo "No migration files found — skipping migrate deploy"
  fi
else
  echo "DATABASE_URL not set; skipping migrations"
fi

exec node dist/server.js
