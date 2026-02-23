-- Add Xero invoice reference fields to prepayments table
ALTER TABLE prepayments ADD COLUMN xero_invoice_id TEXT;
ALTER TABLE prepayments ADD COLUMN xero_invoice_url TEXT;
