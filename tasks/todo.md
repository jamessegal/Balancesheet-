# Balance Sheet Tool — Product Backlog

## Bugs
- [x] **#16 Pension payable BF dates missing** — Fixed: `itemDate` now included in BF query and displayed in Date column.

## Features — High Priority
- [x] **#2 Reconciliation status on period summary** — Progress bar, per-account tick/variance, reconciled count.
- [x] **#4 User management** — Admin CRUD for users (manual creation, temp password, role editing, password reset, delete). Client allocation still pending.
- [ ] **#7 2FA / security hardening** — Add TOTP-based 2FA, password complexity rules, rate limiting on login, session timeout.
- [ ] **#8 Secure file storage** — Move bank statement storage from DB `text` column to encrypted object storage (S3 with SSE). Add at-rest encryption for Postgres.
- [x] **#14/15 GL re-upload safety** — Preview diff before re-upload (per-account changes: added/removed/modified with txn counts and net amounts). User must confirm.

## Features — Medium Priority
- [ ] **#10 Skip unchanged reconciled accounts** — Auto-detect zero-movement + prior-approved accounts. Show "No change — carried forward" badge. Reduce wasted clicks.
- [x] **#11 Number font improvement** — `.font-mono` overridden to use `tabular-nums` with Inter. No more monospace aesthetic.
- [x] **#12 Export reconciliation packs** — Excel (.xlsx) export with Summary + Account Details sheets. Download from period page.
- [ ] **#13 Post journals to Xero** — Use `PUT /ManualJournals` to post adjustments identified during reconciliation. Add approval workflow before posting.

## Features — Lower Priority / Future
- [ ] **#6 Admin dashboard** — Build admin-specific pages: user management (done), audit logs, system settings.
- [ ] **#9 Fixed assets recon module** — New module for fixed assets with depreciation schedules, cost/NBV tracking. Optionally integrate Xero Fixed Assets API.

## Design Decisions Needed
- **#3 Workflow automation** — Consider auto-transition to `in_progress` when user first adds a reconciliation item (saves one click). Current manual flow is acceptable for audit trail.
- **#10 UX for skipped accounts** — Show greyed out in list with badge, or hide behind toggle? Need to decide.
- **#4 Client allocation** — Add `client_assignments` table to control which users can see/work on which clients.

---

## Completed Sprint: Quick Wins + Top 5 Priorities

### Quick Wins (all complete)
- [x] QW1: Extract `formatCurrency`/`formatCurrencyShort`/`formatDateUK` to shared `lib/format.ts`
- [x] QW2: Number font fix — `.font-mono` → `tabular-nums` with Inter
- [x] QW3: Active nav highlighting — client-side NavLinks component
- [x] QW4: Fix pension BF dates bug (#16) — `itemDate` in BF query + Date column
- [x] QW5: Reconciliation % on period summary — progress bar + per-account recon tick
- [x] QW6: Date format DD/MM/YYYY — `formatDateUK` applied to all transaction dates

### Top Priorities (all complete)
- [x] TP1: User management — admin page with create/edit-role/reset-password/delete
- [x] TP2: Month-end pack export — Excel (.xlsx) with Summary + Account Details sheets
- [x] TP3: GL re-upload safety — preview diff, warn user, require confirmation
- [x] TP4: Period locking — `checkAccountLocked` blocks writes on approved accounts/periods
- [x] TP5: Confirmation dialogs — reusable ConfirmDialog component + inline confirmations
