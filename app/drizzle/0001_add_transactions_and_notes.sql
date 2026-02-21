DO $$ BEGIN
  CREATE TYPE "public"."note_type" AS ENUM('prep', 'review', 'general');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recon_account_id" uuid NOT NULL,
	"xero_line_item_id" text,
	"xero_journal_id" text,
	"transaction_date" date NOT NULL,
	"description" text,
	"reference" text,
	"contact_name" text,
	"debit" numeric(18, 2) DEFAULT '0',
	"credit" numeric(18, 2) DEFAULT '0',
	"source_type" text,
	"raw_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recon_account_id" uuid NOT NULL,
	"note_type" "note_type" NOT NULL,
	"content" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_recon_account_id_reconciliation_accounts_id_fk" FOREIGN KEY ("recon_account_id") REFERENCES "public"."reconciliation_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "account_notes" ADD CONSTRAINT "account_notes_recon_account_id_reconciliation_accounts_id_fk" FOREIGN KEY ("recon_account_id") REFERENCES "public"."reconciliation_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "account_notes" ADD CONSTRAINT "account_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_transactions_recon" ON "account_transactions" USING btree ("recon_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_transactions_xero" ON "account_transactions" USING btree ("xero_journal_id");
