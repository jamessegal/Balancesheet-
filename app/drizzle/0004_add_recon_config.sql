-- Account reconciliation config: maps BS accounts to reconciliation module types per client
CREATE TABLE IF NOT EXISTS "account_recon_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id"),
  "xero_account_id" text,
  "account_name" text NOT NULL,
  "recon_module" text NOT NULL DEFAULT 'simple_list',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_recon_config_client_account_unique" UNIQUE("client_id", "xero_account_id")
);

CREATE INDEX IF NOT EXISTS "idx_recon_config_client" ON "account_recon_config" ("client_id");

-- Add gl_transaction_id to reconciliation_items so items can link back to GL source
ALTER TABLE "reconciliation_items" ADD COLUMN IF NOT EXISTS "gl_transaction_id" uuid REFERENCES "gl_transactions"("id");
