-- Remove Xero invoice reference fields from prepayments table (unused — invoices go to P&L not directly to prepayments)
ALTER TABLE prepayments DROP COLUMN IF EXISTS xero_invoice_id;
ALTER TABLE prepayments DROP COLUMN IF EXISTS xero_invoice_url;
