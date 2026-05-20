#!/bin/sh
set -e

if [ -n "${DATABASE_URL:-}" ]; then
  echo "Running Prisma migrations..."
  npx prisma migrate deploy --schema="prisma/schema.prisma"
else
  echo "DATABASE_URL not set; skipping migrations"
fi

exec node dist/server.js
