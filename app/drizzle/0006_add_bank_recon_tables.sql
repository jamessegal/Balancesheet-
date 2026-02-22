-- Bank Reconciliation module: statement records and reconciling items

-- One record per bank account per period
CREATE TABLE IF NOT EXISTS "bank_recon_statements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recon_account_id" uuid NOT NULL REFERENCES "reconciliation_accounts"("id"),
  "statement_date" date NOT NULL,
  "statement_balance" numeric(18, 2) NOT NULL,
  "gl_balance" numeric(18, 2) NOT NULL,
  "currency" varchar(3) NOT NULL DEFAULT 'GBP',
  "document_file_name" text,
  "document_file_key" text,
  "status" text NOT NULL DEFAULT 'pending',
  "tolerance_used" numeric(18, 2) NOT NULL DEFAULT '0',
  "notes" text,
  "confirmed_by" uuid REFERENCES "users"("id"),
  "confirmed_at" timestamptz,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("recon_account_id")
);

-- Reconciling items: only populated when statement and GL balances differ
CREATE TABLE IF NOT EXISTS "bank_recon_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recon_account_id" uuid NOT NULL REFERENCES "reconciliation_accounts"("id"),
  "item_type" text NOT NULL DEFAULT 'other',
  "description" text NOT NULL,
  "amount" numeric(18, 2) NOT NULL,
  "transaction_date" date,
  "reference" text,
  "xero_transaction_id" text,
  "source" text NOT NULL DEFAULT 'manual',
  "is_ticked" boolean NOT NULL DEFAULT false,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_bank_recon_items_account" ON "bank_recon_items"("recon_account_id");
CREATE INDEX IF NOT EXISTS "idx_bank_recon_statements_account" ON "bank_recon_statements"("recon_account_id");
