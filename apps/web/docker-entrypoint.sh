#!/bin/sh
set -e

echo "── Running database migrations ──"
NODE_PATH=/app/migrate-deps/node_modules node apps/web/scripts/migrate.mjs

echo "── Starting application ──"
exec node apps/web/server.js
