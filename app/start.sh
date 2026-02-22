#!/bin/sh
echo "=== Resetting migration tracking (one-time fix) ==="
node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
sql\`DROP TABLE IF EXISTS __drizzle_migrations\`.then(() => {
  console.log('Migration tracking reset');
  sql.end();
}).catch(e => {
  console.log('Reset skipped:', e.message);
  sql.end();
});
" 2>&1 || true
echo "=== Pushing database schema ==="
npx drizzle-kit push --force 2>&1 || echo "Warning: db:push failed, continuing..."
echo "=== Starting server ==="
exec pnpm start
