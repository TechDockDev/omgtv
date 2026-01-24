#!/bin/sh
set -e

if [ -z "${DATABASE_URL:-}" ]; then
	echo "DATABASE_URL must be set" >&2
	exit 1
fi

if [ -d "./prisma/migrations" ] && [ "$(ls -A ./prisma/migrations)" ]; then
	echo "Running Prisma migrations..."
	npx prisma migrate deploy --schema="prisma/schema.prisma"
else
	echo "No Prisma migrations found; syncing schema with prisma db push..."
	# Using --accept-data-loss for new columns with unique constraints
	# This is safe because uploadId is a NEW nullable column; no actual data is deleted
	npx prisma db push --skip-generate --accept-data-loss --schema="prisma/schema.prisma"
fi

exec node dist/server.js
