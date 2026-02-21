#!/bin/sh
echo "=== Pushing database schema ==="
yes | pnpm db:push 2>&1 || echo "Warning: db:push failed, continuing..."
echo "=== Starting server ==="
exec pnpm start
