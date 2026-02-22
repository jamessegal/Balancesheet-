-- Accounts Receivable Reconciliation module

-- Enum types
DO $$ BEGIN
  CREATE TYPE "ar_recon_status" AS ENUM ('draft', 'complete', 'reviewed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ar_risk_flag" AS ENUM ('none', 'watch', 'high');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ar_aging_bucket" AS ENUM ('current', '1_30', '31_60', '61_90', '90_plus');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One reconciliation record per AR account per period
CREATE TABLE IF NOT EXISTS "ar_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recon_account_id" uuid NOT NULL REFERENCES "reconciliation_accounts"("id"),
  "month_end_date" date NOT NULL,
  "ledger_balance" numeric(18, 2) NOT NULL,
  "aged_report_total" numeric(18, 2),
  "variance" numeric(18, 2),
  "status" "ar_recon_status" NOT NULL DEFAULT 'draft',
  "signed_off_by" uuid REFERENCES "users"("id"),
  "signed_off_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("recon_account_id")
);

-- Snapshot of each outstanding invoice as at month end
CREATE TABLE IF NOT EXISTS "ar_invoice_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "reconciliation_id" uuid NOT NULL REFERENCES "ar_reconciliations"("id") ON DELETE CASCADE,
  "xero_invoice_id" text,
  "invoice_number" text,
  "contact_name" text NOT NULL,
  "invoice_date" date,
  "due_date" date,
  "original_amount" numeric(18, 2) NOT NULL,
  "outstanding_amount" numeric(18, 2) NOT NULL,
  "aging_bucket" "ar_aging_bucket" NOT NULL DEFAULT 'current',
  "days_overdue" integer NOT NULL DEFAULT 0,
  "requires_comment" boolean NOT NULL DEFAULT false,
  "comment_text" text,
  "risk_flag" "ar_risk_flag" NOT NULL DEFAULT 'none',
  "reviewed" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Audit trail for changes to invoice snapshots
CREATE TABLE IF NOT EXISTS "ar_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "invoice_snapshot_id" uuid NOT NULL REFERENCES "ar_invoice_snapshots"("id") ON DELETE CASCADE,
  "change_type" text NOT NULL,
  "previous_value" text,
  "new_value" text,
  "timestamp" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_ar_recon_account" ON "ar_reconciliations"("recon_account_id");
CREATE INDEX IF NOT EXISTS "idx_ar_snapshots_recon" ON "ar_invoice_snapshots"("reconciliation_id");
CREATE INDEX IF NOT EXISTS "idx_ar_snapshots_bucket" ON "ar_invoice_snapshots"("aging_bucket");
CREATE INDEX IF NOT EXISTS "idx_ar_audit_snapshot" ON "ar_audit_log"("invoice_snapshot_id");
CREATE INDEX IF NOT EXISTS "idx_ar_audit_user" ON "ar_audit_log"("user_id");
