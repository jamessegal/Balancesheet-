# Fin-House Balance Sheet Tool — Comprehensive Review

## Executive Summary

Fin-House is a functional balance sheet reconciliation tool with solid foundations: a clean Next.js architecture, proper Xero OAuth integration, modular reconciliation types, and a sensible data model. It's at a strong MVP stage — the core reconciliation workflow works end-to-end.

This review covers what's working well, what needs attention before production use with real clients, and what would elevate the tool into something genuinely differentiated. Recommendations are prioritised as **Now** (before real client use), **Next** (near-term improvements), and **Later** (feature expansion).

---

## 1. Functionality & Reconciliation Modules

### What's working well
- **Six recon modules** already built: simple list, pensions payable, bank, prepayments, deferred income, accounts receivable. Good coverage of common balance sheet items.
- **Brought forward / carried forward** logic is well-thought-out — prior period items automatically feed into the next month's BF section.
- **Pensions payable** module is particularly strong: multi-payment matching, rounding detection, suggested matches, partial clearing with residual tracking.
- **Prepayment/deferred income** schedules with three spread methods (equal, daily proration, half-month) and override capability.
- **GL upload** parser handles multiple Xero export formats, parenthesised negatives, multiple date formats.

### Gaps & Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **No fixed assets module** | Fixed assets show as simple list. Need cost, accumulated depreciation, NBV, additions/disposals tracking. Could optionally pull from Xero FA API. | Next |
| **Wages payable, accruals, share capital, directors loan, other debtors, accounts payable** — all listed in `RECON_MODULES` but not implemented | These default to `simple_list`. Should at least have wages payable (similar to pensions) and accruals (common). | Next |
| **No "no movement" detection** | Accounts with zero movement that were reconciled last month still require full prep/review. Should auto-detect and allow quick carry-forward. | Now |
| **BF dates lost on pensions payable** | `itemDate` exists in DB but isn't passed to BF display. Confirmed bug. | Now |
| **No reconciliation templates** | Each new period requires setting up the same accounts from scratch. Should carry forward recon config and module assignments automatically (it does for config, but not for the reconciliation items themselves as templates). | Next |
| **Prepayment/deferred income code duplication** | These two modules are ~95% identical. Should extract shared schedule logic into a common component/utility. | Next |
| **No journal suggestions** | The tool identifies variances and rounding but doesn't suggest the actual journal entries needed. A "generate journal" feature from reconciliation differences would save significant time. | Later |
| **Period locking** | After a period is approved, it can still be modified (re-pull balance sheet, re-upload GL). Need a hard lock option. | Now |

---

## 2. Data Integrity & GL Upload Workflow

### What's working well
- GL data and reconciliation work are stored separately — re-uploading GL doesn't destroy reconciliation items, notes, or statuses.
- Reconciliation items reference the account via `reconAccountId`, not the GL transaction, so they survive data refreshes.

### Gaps & Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **GL re-upload is destructive** | All previous GL transactions are deleted and replaced. No versioning, no diff, no warning about what changed. If a prior month changed, you'd never know. | Now |
| **No GL upload history** | Only the latest upload is kept. Should store upload history so you can see what changed between uploads and when. | Now |
| **Balance sheet re-pull overwrites balances** | After posting journals and re-pulling, account balances update but there's no record of what the previous balance was (aside from `priorBalance` which is the previous *month*, not the previous *pull*). | Next |
| **No change detection** | If a prior month's GL changes after it was reconciled, there's no alert. Should flag when re-uploaded data differs from what was reconciled against. | Next |
| **Bulk operations not atomic** | Several server actions (recon config bulk save, multi-step GL upload) don't wrap operations in database transactions. A failure mid-way leaves partial state. | Now |
| **GL parser fragility** | Column detection is heuristic-based. Edge cases: BOM characters in Excel exports, accounts with dashes in names, case-sensitive header matching. | Next |

---

## 3. User Access & Roles

### What's working well
- Three-tier role hierarchy (admin > manager > junior) is correctly enforced server-side.
- Managers can do everything juniors can, plus approve/reopen/manage.
- `preparedBy` and `approvedBy` tracked per account for audit trail.

### Gaps & Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **No user management UI** | Users can only be created via database seed scripts. Need an admin page to create, edit, disable users. | Now |
| **No client-user allocation** | Every user sees every client. Need a `client_assignments` table so you can control which staff work on which clients. | Now |
| **No user invite flow** | No way to invite a new user via email. They'd need to be manually created. | Next |
| **Password management** | No password reset, no password change, no password complexity rules. | Now |
| **Junior sees everything manager sees** | UI doesn't hide manager-only sections — buttons are hidden but data is still visible. Could be confusing. | Next |
| **No activity log** | No record of who did what and when (beyond preparedBy/approvedBy). Need a proper audit log for compliance. | Now |
| **Session management** | No session timeout, no "remember me" option, no concurrent session limits, no session revocation. | Next |

---

## 4. Security

### What's working well
- Xero tokens encrypted at rest with AES-256-GCM (proper IV, auth tag).
- Passwords hashed with bcrypt.
- Server-side role checks on all actions (not just UI hiding).
- CSRF protection on Xero OAuth flow (state + cookie validation).

### Gaps & Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **No 2FA** | For a tool handling financial data and bank statements, TOTP-based 2FA should be mandatory. | Now |
| **No rate limiting** | Login endpoint has no rate limiting. Brute force attacks possible. | Now |
| **Bank statements stored as base64 in DB** | No encryption at rest for documents. Bloats database. Should use encrypted object storage (S3 with SSE or similar). | Now |
| **No security headers** | No Content-Security-Policy, X-Frame-Options, HSTS etc. No `helmet` or equivalent. | Now |
| **No input sanitisation** | User-entered notes and descriptions are rendered directly. XSS risk in note content (React does escape by default, but `dangerouslySetInnerHTML` anywhere would be a problem). Currently safe due to React's escaping, but should add explicit sanitisation as defence in depth. | Next |
| **File uploads not scanned** | Bank statement uploads not validated for malware. | Next |
| **No audit logging** | Security-relevant events (login, role changes, data access) not logged. | Now |
| **Beta dependencies** | `next-auth@5.0.0-beta.30` and `next@16.1.6` are pre-release. Security patches may lag. | Next |
| **Database credentials in environment** | Standard practice, but for production should use a secrets manager (AWS Secrets Manager, Vault). | Later |
| **No IP allowlisting** | Anyone with credentials can access from anywhere. Consider IP restrictions for production. | Later |

---

## 5. UI/UX

### What's working well
- Clean, professional design using Tailwind.
- Good use of colour-coded status badges (draft=grey, in progress=blue, review=yellow, approved=green).
- Forward/backward navigation between months and accounts.
- Balance sheet grouped by section (Fixed Assets, Current Assets, etc.) with subtotals.
- Balance sheet balancing check (net assets vs equity) with green/red indicator.
- Inline reconciliation with add/remove and real-time variance calculation.

### Gaps & Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **Number font** | `font-mono` (Menlo/Consolas) mixed with Inter body text looks jarring. Should use Inter with `font-variant-numeric: tabular-nums` for aligned columns without the monospace aesthetic. Or use a dedicated numeric font like Tabular from Inter's OpenType features. | Now |
| **No reconciliation % on period summary** | The month summary shows Draft/In Progress/Review/Approved counts but NOT whether each account is actually reconciled (variance = 0). This is the most important metric. | Now |
| **No confirmation dialogs** | Deleting reconciliation items, removing notes, re-uploading GL — all happen instantly with no "are you sure?" | Now |
| **No loading skeletons** | Pages are blank while data loads. Should show skeleton/shimmer states. | Next |
| **Date format inconsistent** | Date inputs show YYYY-MM-DD (ISO) but users are UK accountants who expect DD/MM/YYYY. | Now |
| **No search or filter** | Client list, account list, transaction list — none have search. At 50+ accounts per client, this becomes painful. | Next |
| **No keyboard shortcuts** | For a tool used heavily by accountants, keyboard nav (Tab through fields, Enter to save, Escape to cancel) would dramatically speed up workflows. The AR module has some, but it's inconsistent. | Later |
| **Mobile responsiveness** | Table-heavy layouts break on small screens. Not critical if this is desktop-only, but should be explicit about that. | Later |
| **No dark mode** | Minor, but accountants staring at screens all day would appreciate it. | Later |
| **No success/error toasts** | Actions complete silently. Should show brief toast notifications for confirmations. | Next |
| **Breadcrumb navigation good** | Already in place — Clients > Client > Period > Account. Works well. | - |
| **Active nav state missing** | Navigation bar doesn't highlight the current page. | Now |
| **Horizontal scrolling on prepayment schedules** | Multi-month schedule tables overflow on smaller screens. Need responsive table or horizontal scroll indicator. | Next |

---

## 6. Xero Integration

### What's working well
- OAuth 2.0 PKCE flow properly implemented.
- Token refresh handled automatically before API calls.
- Multiple Xero endpoints used (Accounts, Invoices, BankTransactions, ManualJournals, CreditNotes, BalanceSheet).
- Rate limiting respected with 1.2s delays between calls.
- Pagination for large result sets.

### Gaps & Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **Read-only integration** | Cannot post journals back to Xero. This is the most requested feature gap — users identify adjustments but must manually enter them in Xero. | Next |
| **No webhook support** | Relies on manual "Pull" buttons. Xero webhooks could notify of changes automatically. | Later |
| **No bulk sync** | Each account's transactions pulled individually via API. Should batch where possible. | Next |
| **Connection health monitoring** | Token expiry shown but no proactive notification. If token expires overnight, user discovers it mid-workflow. | Next |
| **No Xero Fixed Assets API** | Could pull asset registers, depreciation schedules if the client uses Xero FA module. | Later |
| **Rate limit handling** | Current 1.2s delay is conservative but doesn't handle 429 responses gracefully — should implement exponential backoff. | Next |
| **Stale data indicator** | No "last synced" display on the UI. Users can't tell if they're looking at data from 5 minutes ago or 5 days ago. | Now |

---

## 7. Exporting & Reporting

### Current state: Nothing built.

### Recommendations

| Feature | Detail | Priority |
|---------|--------|----------|
| **Month-end pack export** | Single PDF/Excel download for an entire period: all accounts, reconciliation items, notes, status, preparer/reviewer names. This is the #1 export need — auditors want one file per month. | Now |
| **Per-account export** | Optional per-code download for drilling into individual accounts. | Next |
| **Format** | PDF for review packs (professional layout, headers, sign-off lines). Excel for working papers (editable, filterable). | Now |
| **Audit trail export** | CSV/Excel of all changes, status transitions, notes for compliance. | Next |
| **Scheduled exports** | Auto-generate month-end packs when period is approved. | Later |

Implementation approach: `@react-pdf/renderer` for PDF generation, `xlsx` (already a dependency) for Excel export. Server action that queries all data for a period and generates the file.

---

## 8. Performance & Scalability

### Current state
- Suitable for small scale (~5-10 clients, ~50 accounts each, 1-5 users).
- No caching layer despite Redis being in docker-compose.
- No pagination on list views.

### Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **Add pagination** | Account lists, transaction tables, note lists — all load everything. At 200+ GL transactions per account, this will slow down. | Next |
| **Use Redis for caching** | Redis is already in docker-compose but unused. Cache Xero API responses, session data, frequently-accessed queries. | Next |
| **Lazy-load xlsx library** | The `xlsx` package is ~3.7MB. Should dynamically import only when user actually uploads a file. | Next |
| **Database connection pooling** | The `postgres` driver doesn't pool by default. For production, use PgBouncer or configure pool settings. | Now |
| **N+1 queries in AR module** | Invoice updates happen one at a time in loops. Should batch into single UPDATE queries. | Next |
| **React.memo on table rows** | Large tables (50+ rows) re-render entirely on any state change. Memoize row components. | Later |

---

## 9. Testing

### Current state: Zero tests.

### Recommendations

| Area | Detail | Priority |
|------|--------|----------|
| **GL parser unit tests** | This is the most critical thing to test — it handles multiple date formats, negative amounts, account code detection, various Excel layouts. Regressions here silently corrupt data. | Now |
| **Server action integration tests** | Status transitions, role enforcement, reconciliation calculations. | Now |
| **Xero token encryption round-trip** | Ensure encrypt → store → retrieve → decrypt works correctly. | Now |
| **Reconciliation variance calculations** | Floating-point arithmetic on financial data needs explicit test coverage. | Now |
| **E2E smoke tests** | Basic flow: login → create client → open period → pull BS → reconcile → approve. | Next |
| **Test framework** | Add Vitest (lighter than Jest, native ESM support, works well with Next.js). | Now |

---

## 10. Code Quality & Architecture

### What's working well
- Clean separation: pages (server components) → actions (server functions) → DB (Drizzle ORM).
- Schema well-organised with clear section comments.
- TypeScript throughout with inferred types from Drizzle.

### Recommendations

| Issue | Detail | Priority |
|-------|--------|----------|
| **Extract shared code** | Prepayment and deferred income modules are ~95% identical. Extract shared schedule component and utility functions. | Next |
| **Constants file** | Magic numbers everywhere: `0.005` rounding tolerance, `5MB` file limit, `1.2s` API delay, `100` pagination size, `500` batch size. Centralise in a `constants.ts`. | Next |
| **Database transactions** | Multi-step operations (GL upload, bulk config save, AR refresh) should be wrapped in DB transactions to prevent partial state. | Now |
| **Error handling strategy** | Inconsistent: some actions return `{ error }`, some throw, some silently catch. Standardise on a pattern. | Next |
| **Logging** | Only `console.log` used. Add structured logging (e.g., Pino) with correlation IDs for production debugging. | Next |
| **`formatCurrency` duplicated** | The same function is copy-pasted in 5+ files. Extract to a shared utility. | Now |

---

## 11. Deployment & Operations

### Current state
- Docker Compose with Postgres + Redis.
- Railway.json suggests Railway deployment target.
- No CI/CD configuration visible.

### Recommendations

| Area | Detail | Priority |
|------|--------|----------|
| **CI/CD pipeline** | Add GitHub Actions: lint, type-check, test, build on PR. Deploy on merge to main. | Now |
| **Environment management** | Separate configs for dev/staging/production. | Now |
| **Database backups** | No backup strategy visible. For financial data, automated daily backups with point-in-time recovery. | Now |
| **Monitoring** | No error tracking (Sentry), no uptime monitoring, no performance monitoring. | Now |
| **HTTPS enforcement** | Not configured at app level. Must be enforced at infrastructure layer. | Now |

---

## Priority Summary

### Now (before real client use)
1. User management UI + client allocation
2. 2FA authentication
3. Reconciliation % on period summary
4. Month-end pack export (PDF/Excel)
5. GL re-upload versioning & change detection
6. Period locking after approval
7. Rate limiting on login
8. Security headers
9. Audit logging
10. Database transactions on multi-step operations
11. Number font fix (tabular-nums)
12. Date format (DD/MM/YYYY for UK users)
13. Confirmation dialogs on destructive actions
14. Active nav highlighting
15. Stale data / last synced indicator
16. GL parser tests + reconciliation calculation tests
17. Fix pensions BF dates bug
18. No-movement account detection / auto-carry-forward
19. Database backups
20. CI/CD pipeline

### Next (near-term improvements)
1. Post journals to Xero
2. Remaining recon modules (wages, accruals)
3. Fixed assets module
4. Search/filter on all list views
5. Loading skeletons
6. Toast notifications
7. Extract shared prepayment/deferred income code
8. Pagination on all lists
9. Redis caching
10. Connection health monitoring
11. Per-account export option
12. Password management (reset, change, complexity)
13. Session management
14. Structured logging

### Later (feature expansion)
1. Xero webhooks for auto-sync
2. Keyboard shortcuts
3. Mobile responsive
4. Dark mode
5. Scheduled/automated exports
6. Xero Fixed Assets API
7. Multi-currency support
8. IP allowlisting
9. Secrets manager integration
