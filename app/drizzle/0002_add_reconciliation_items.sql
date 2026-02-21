CREATE TABLE IF NOT EXISTS "reconciliation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recon_account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_recon_account_id_reconciliation_accounts_id_fk" FOREIGN KEY ("recon_account_id") REFERENCES "public"."reconciliation_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reconciliation_items_recon" ON "reconciliation_items" USING btree ("recon_account_id");
