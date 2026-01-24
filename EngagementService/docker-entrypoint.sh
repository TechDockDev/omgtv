#!/bin/sh
set -e

# DATABASE_URL is optional for EngagementService (Redis-first approach)
if [ -n "${DATABASE_URL:-}" ]; then
  if [ -d "./prisma/migrations" ] && [ "$(ls -A ./prisma/migrations)" ]; then
    echo "Running Prisma migrations..."
    npx prisma migrate deploy --schema="prisma/schema.prisma"
  else
    echo "No Prisma migrations found; syncing schema with prisma db push..."
    npx prisma db push --skip-generate --schema="prisma/schema.prisma"
  fi
else
  echo "DATABASE_URL not set; running in Redis-only mode"
fi

exec node dist/server.js
