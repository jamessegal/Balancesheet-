# Balance Sheet Tool — Product Backlog

## Bugs
- [ ] **#16 Pension payable BF dates missing** — `itemDate` is in the DB but not passed through to the pensions BF display. Fix: include `itemDate` in prior items query and `BFItem` interface.

## Features — High Priority
- [ ] **#2 Reconciliation status on period summary** — Show per-account reconciled tick (variance < 0.01) and overall "X/Y reconciled (Z%)" on the period page.
- [ ] **#4 User management + client allocation** — Admin UI for creating users, `client_assignments` table to control which users can see/work on which clients.
- [ ] **#7 2FA / security hardening** — Add TOTP-based 2FA, password complexity rules, rate limiting on login, session timeout.
- [ ] **#8 Secure file storage** — Move bank statement storage from DB `text` column to encrypted object storage (S3 with SSE). Add at-rest encryption for Postgres.
- [ ] **#14/15 GL re-upload safety** — Version GL uploads, compare old vs new, flag changes in prior months. Confirm reconciliation work is preserved (it is) and document the re-upload workflow.

## Features — Medium Priority
- [ ] **#10 Skip unchanged reconciled accounts** — Auto-detect zero-movement + prior-approved accounts. Show "No change — carried forward" badge. Reduce wasted clicks.
- [ ] **#11 Number font improvement** — Replace `font-mono` on numbers with tabular-nums on a proper font (Inter or similar). Consider `font-variant-numeric: tabular-nums`.
- [ ] **#12 Export reconciliation packs** — Export entire month as single PDF/Excel download. Optional per-account export. PDF for review packs, Excel for working papers.
- [ ] **#13 Post journals to Xero** — Use `PUT /ManualJournals` to post adjustments identified during reconciliation. Add approval workflow before posting.

## Features — Lower Priority / Future
- [ ] **#6 Admin dashboard** — Build admin-specific pages: user management, audit logs, system settings.
- [ ] **#9 Fixed assets recon module** — New module for fixed assets with depreciation schedules, cost/NBV tracking. Optionally integrate Xero Fixed Assets API.

## Design Decisions Needed
- **#3 Workflow automation** — Consider auto-transition to `in_progress` when user first adds a reconciliation item (saves one click). Current manual flow is acceptable for audit trail.
- **#10 UX for skipped accounts** — Show greyed out in list with badge, or hide behind toggle? Need to decide.
- **#12 Export format** — PDF vs Excel vs both? Single month pack vs per-code? Likely: single download for entire month.
