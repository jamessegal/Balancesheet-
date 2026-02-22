#!/bin/sh
echo "=== Running schema migrations ==="
node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
async function migrate() {
  // Add document_data and document_mime_type columns if they don't exist
  await sql.unsafe(\`
    ALTER TABLE bank_recon_statements
    ADD COLUMN IF NOT EXISTS document_data text,
    ADD COLUMN IF NOT EXISTS document_mime_type text
  \`);
  console.log('Schema migration complete');
  await sql.end();
}
migrate().catch(e => {
  console.log('Migration skipped:', e.message);
  sql.end();
});
" 2>&1 || true
echo "=== Starting server ==="
exec pnpm start
