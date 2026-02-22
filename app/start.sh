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

  // Create prepayment_status enum if it doesn't exist
  await sql.unsafe(\`
    DO \\\$\\\$ BEGIN
      CREATE TYPE prepayment_status AS ENUM ('active', 'fully_amortised', 'cancelled');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END \\\$\\\$;
  \`);

  // Create prepayments table if it doesn't exist
  await sql.unsafe(\`
    CREATE TABLE IF NOT EXISTS prepayments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id),
      vendor_name text NOT NULL,
      description text,
      nominal_account text,
      start_date date NOT NULL,
      end_date date NOT NULL,
      total_amount numeric(18, 2) NOT NULL,
      currency varchar(3) NOT NULL DEFAULT 'GBP',
      number_of_months integer NOT NULL,
      monthly_amount numeric(18, 2) NOT NULL,
      status prepayment_status NOT NULL DEFAULT 'active',
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  \`);
  await sql.unsafe(\`
    CREATE INDEX IF NOT EXISTS idx_prepayments_client ON prepayments(client_id)
  \`);

  // Create prepayment_schedule_lines table if it doesn't exist
  await sql.unsafe(\`
    CREATE TABLE IF NOT EXISTS prepayment_schedule_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      prepayment_id uuid NOT NULL REFERENCES prepayments(id) ON DELETE CASCADE,
      month_end_date date NOT NULL,
      opening_balance numeric(18, 2) NOT NULL,
      monthly_expense numeric(18, 2) NOT NULL,
      closing_balance numeric(18, 2) NOT NULL,
      original_amount numeric(18, 2) NOT NULL,
      override_amount numeric(18, 2),
      is_overridden boolean NOT NULL DEFAULT false,
      audit_notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(prepayment_id, month_end_date)
    )
  \`);
  await sql.unsafe(\`
    CREATE INDEX IF NOT EXISTS idx_prepayment_schedule_prepayment ON prepayment_schedule_lines(prepayment_id)
  \`);
  await sql.unsafe(\`
    CREATE INDEX IF NOT EXISTS idx_prepayment_schedule_month ON prepayment_schedule_lines(month_end_date)
  \`);

  console.log('Schema migration complete');
  await sql.end();
}
migrate().catch(e => {
  console.log('Migration failed:', e.message);
  sql.end();
});
" 2>&1 || true
echo "=== Starting server ==="
exec pnpm start
