#!/bin/sh
echo "=== Running database migrations ==="
pnpm db:migrate 2>&1 || echo "Warning: db:migrate failed, continuing..."
echo "=== Starting server ==="
exec pnpm start
