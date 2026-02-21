DO $$ BEGIN
  CREATE TYPE "public"."account_status" AS ENUM('draft', 'in_progress', 'ready_for_review', 'approved', 'reopened');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."period_status" AS ENUM('draft', 'in_progress', 'ready_for_review', 'approved', 'reopened');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"status" "period_status" DEFAULT 'draft' NOT NULL,
	"opened_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_periods_client_id_period_year_period_month_unique" UNIQUE("client_id","period_year","period_month")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"xero_account_id" text NOT NULL,
	"account_code" text,
	"account_name" text NOT NULL,
	"account_type" text NOT NULL,
	"balance" numeric(18, 2) NOT NULL,
	"prior_balance" numeric(18, 2),
	"status" "account_status" DEFAULT 'draft' NOT NULL,
	"prepared_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_accounts_period_id_xero_account_id_unique" UNIQUE("period_id","xero_account_id")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reconciliation_periods" ADD CONSTRAINT "reconciliation_periods_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reconciliation_periods" ADD CONSTRAINT "reconciliation_periods_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reconciliation_accounts" ADD CONSTRAINT "reconciliation_accounts_period_id_reconciliation_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."reconciliation_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reconciliation_accounts" ADD CONSTRAINT "reconciliation_accounts_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reconciliation_accounts" ADD CONSTRAINT "reconciliation_accounts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
