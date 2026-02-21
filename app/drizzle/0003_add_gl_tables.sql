CREATE TABLE IF NOT EXISTS "gl_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"account_count" integer DEFAULT 0 NOT NULL,
	"date_from" date,
	"date_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gl_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text NOT NULL,
	"transaction_date" date NOT NULL,
	"source" text,
	"description" text,
	"reference" text,
	"contact" text,
	"debit" numeric(18, 2) DEFAULT '0',
	"credit" numeric(18, 2) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gl_uploads" ADD CONSTRAINT "gl_uploads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gl_uploads" ADD CONSTRAINT "gl_uploads_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gl_transactions" ADD CONSTRAINT "gl_transactions_upload_id_gl_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."gl_uploads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gl_transactions" ADD CONSTRAINT "gl_transactions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gl_transactions_client" ON "gl_transactions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gl_transactions_account" ON "gl_transactions" USING btree ("client_id", "account_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gl_transactions_date" ON "gl_transactions" USING btree ("client_id", "transaction_date");
