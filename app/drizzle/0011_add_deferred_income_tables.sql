-- Deferred Income tables (mirror of prepayments for income received in advance)

DO $$ BEGIN
  CREATE TYPE deferred_income_status AS ENUM ('active', 'fully_recognised', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE deferred_income_spread_method AS ENUM ('equal', 'daily_proration', 'half_month');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS deferred_income_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  customer_name TEXT NOT NULL,
  description TEXT NOT NULL,
  nominal_account TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total_amount NUMERIC(18, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'GBP',
  number_of_months INTEGER NOT NULL,
  monthly_amount NUMERIC(18, 2) NOT NULL,
  spread_method deferred_income_spread_method NOT NULL DEFAULT 'equal',
  status deferred_income_status NOT NULL DEFAULT 'active',
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deferred_income_client ON deferred_income_items(client_id);

CREATE TABLE IF NOT EXISTS deferred_income_schedule_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deferred_income_id UUID NOT NULL REFERENCES deferred_income_items(id) ON DELETE CASCADE,
  month_end_date DATE NOT NULL,
  opening_balance NUMERIC(18, 2) NOT NULL,
  monthly_recognition NUMERIC(18, 2) NOT NULL,
  closing_balance NUMERIC(18, 2) NOT NULL,
  original_amount NUMERIC(18, 2) NOT NULL,
  override_amount NUMERIC(18, 2),
  is_overridden BOOLEAN NOT NULL DEFAULT FALSE,
  audit_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(deferred_income_id, month_end_date)
);

CREATE INDEX IF NOT EXISTS idx_deferred_income_schedule_item ON deferred_income_schedule_lines(deferred_income_id);
CREATE INDEX IF NOT EXISTS idx_deferred_income_schedule_month ON deferred_income_schedule_lines(month_end_date);
