-- Prepayment status enum
DO $$ BEGIN
  CREATE TYPE "prepayment_status" AS ENUM ('active', 'fully_amortised', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Prepayments table (client-level, spans across periods)
CREATE TABLE IF NOT EXISTS "prepayments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id"),
  "vendor_name" text NOT NULL,
  "description" text,
  "nominal_account" text,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "total_amount" numeric(18, 2) NOT NULL,
  "currency" varchar(3) NOT NULL DEFAULT 'GBP',
  "number_of_months" integer NOT NULL,
  "monthly_amount" numeric(18, 2) NOT NULL,
  "status" "prepayment_status" NOT NULL DEFAULT 'active',
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Prepayment schedule lines (one per month per prepayment)
CREATE TABLE IF NOT EXISTS "prepayment_schedule_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prepayment_id" uuid NOT NULL REFERENCES "prepayments"("id") ON DELETE CASCADE,
  "month_end_date" date NOT NULL,
  "opening_balance" numeric(18, 2) NOT NULL,
  "monthly_expense" numeric(18, 2) NOT NULL,
  "closing_balance" numeric(18, 2) NOT NULL,
  "original_amount" numeric(18, 2) NOT NULL,
  "override_amount" numeric(18, 2),
  "is_overridden" boolean NOT NULL DEFAULT false,
  "audit_notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE("prepayment_id", "month_end_date")
);
--> statement-breakpoint

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_prepayments_client" ON "prepayments" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prepayment_schedule_prepayment" ON "prepayment_schedule_lines" ("prepayment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prepayment_schedule_month" ON "prepayment_schedule_lines" ("month_end_date");
