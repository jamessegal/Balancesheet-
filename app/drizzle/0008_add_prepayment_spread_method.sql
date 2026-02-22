-- Add spread method enum and column to prepayments
CREATE TYPE "public"."prepayment_spread_method" AS ENUM('equal', 'daily_proration', 'half_month');
--> statement-breakpoint
ALTER TABLE "prepayments" ADD COLUMN "spread_method" "prepayment_spread_method" NOT NULL DEFAULT 'equal';
--> statement-breakpoint
-- Make description and nominal_account required (set existing nulls to empty string first)
UPDATE "prepayments" SET "description" = '' WHERE "description" IS NULL;
--> statement-breakpoint
UPDATE "prepayments" SET "nominal_account" = '' WHERE "nominal_account" IS NULL;
--> statement-breakpoint
ALTER TABLE "prepayments" ALTER COLUMN "description" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "prepayments" ALTER COLUMN "nominal_account" SET NOT NULL;
