# Balance Sheet Reconciliation Tool — Architecture & Design

## 1. Overall Architecture

### 1.1 Stack Decision

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│              Next.js 14+ (App Router, TypeScript)            │
│              Server Components + Client Components           │
│              Tailwind CSS + shadcn/ui                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ (same process — no separate API)
┌──────────────────────────▼──────────────────────────────────┐
│                     Next.js API Routes                       │
│              Server Actions + Route Handlers                 │
│              tRPC or plain route handlers (see below)        │
└──────┬──────────────┬────────────────┬─────────────────────┘
       │              │                │
┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼──────┐
│  Postgres   │ │    S3      │ │   Xero API  │
│  (Drizzle   │ │  (MinIO    │ │  (OAuth 2)  │
│   ORM)      │ │   or AWS)  │ │             │
└─────────────┘ └────────────┘ └─────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│                  Background Jobs (BullMQ + Redis)            │
│  • Xero sync    • Ledger-change detection    • AI (later)   │
└─────────────────────────────────────────────────────────────┘
```

**Why this stack:**

| Decision | Rationale |
|---|---|
| **Next.js (App Router)** | You proposed it. Correct choice for internal tool — SSR, file-based routing, server actions reduce boilerplate. No need for a separate backend. |
| **Drizzle ORM** | Type-safe, thin abstraction over SQL, excellent migration story. Prisma is heavier than needed. |
| **Postgres** | Correct. Relational data with complex joins (accounts → transactions → snapshots). JSONB for flexible config. |
| **BullMQ + Redis** | Lightweight job queue. Xero rate limits demand background processing. Cron-style ledger monitoring fits naturally. |
| **S3/MinIO** | For uploaded evidence files. MinIO for local dev, S3 for production. |
| **NextAuth.js (Auth.js v5)** | Handles session management. Credential-based login (email/password) for internal tool. No need for social OAuth for users — Xero OAuth is separate and per-client, not per-user. |

### 1.2 What I'd Push Back On

**You don't need tRPC.** For an internal app with one frontend, Server Actions + route handlers are sufficient. tRPC adds a dependency without meaningful benefit here. If you later need a public API, add it then.

**You don't need a separate backend service.** Next.js API routes + server actions handle everything. A separate Express/Fastify service would double your deployment surface for no gain on an internal tool.

### 1.3 Deployment

For an internal tool serving two firms:

- **Option A (Recommended):** Single VPS (Hetzner/Railway/Render) running Next.js + Postgres + Redis. Simple. Cheap. Sufficient for <50 users.
- **Option B:** Vercel (frontend) + Supabase (Postgres) + Upstash (Redis) + S3. More managed, slightly more complex networking.

Option A is better for internal tools — you control the box, no edge-case serverless issues with long-running Xero syncs.

---

## 2. Database Schema

### 2.1 Design Principles

1. **Organisation isolation is row-level, not schema-level.** Every significant table has `organisation_id`. Row-Level Security (RLS) or application-level enforcement — I recommend application-level via middleware for simplicity with Drizzle.
2. **Snapshots are immutable.** Once written, snapshot rows and their children are never updated or deleted.
3. **Audit columns everywhere.** `created_at`, `updated_at`, `created_by` on every table.
4. **Xero IDs stored as text.** Xero uses UUIDs as strings. Store them as-is for easy lookup.

### 2.2 Entity Relationship Diagram

```
organisations
  ├── users (membership via organisation_users)
  ├── clients
  │     ├── xero_connections
  │     ├── reconciliation_periods
  │     │     ├── reconciliation_accounts
  │     │     │     ├── account_transactions (from Xero)
  │     │     │     ├── account_notes
  │     │     │     ├── account_documents
  │     │     │     ├── checklist_responses
  │     │     │     ├── account_flags
  │     │     │     └── reconciliation_snapshots (immutable on approval)
  │     │     │           ├── snapshot_transactions
  │     │     │           ├── snapshot_documents
  │     │     │           ├── snapshot_checklist
  │     │     │           ├── snapshot_notes
  │     │     │           └── snapshot_flags
  │     │     └── period_status (overall period tracking)
  │     └── prepayment_schedules / accrual_entries (Phase 2)
  └── account_templates (configurable per org)
        └── template_checklist_items
```

### 2.3 Table Definitions

```sql
-- ============================================================
-- ORGANISATIONS & USERS
-- ============================================================

CREATE TABLE organisations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,           -- "Fin-House" or "Startup Accountancy"
    slug            TEXT NOT NULL UNIQUE,    -- "fin-house", "startup-accountancy"
    settings        JSONB DEFAULT '{}',      -- org-level config
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organisation_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    role            TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'junior')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organisation_id, user_id)
);

-- ============================================================
-- CLIENTS & XERO
-- ============================================================

CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    name            TEXT NOT NULL,
    code            TEXT,                    -- short code e.g. "FH001"
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES users(id)
);

CREATE TABLE xero_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES clients(id) UNIQUE,
    xero_tenant_id  TEXT NOT NULL,           -- Xero organisation ID
    access_token    TEXT NOT NULL,            -- encrypted at rest
    refresh_token   TEXT NOT NULL,            -- encrypted at rest
    token_expires_at TIMESTAMPTZ NOT NULL,
    scopes          TEXT[],
    connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    connected_by    UUID REFERENCES users(id),
    last_synced_at  TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ACCOUNT TEMPLATES (configurable per org)
-- ============================================================

CREATE TABLE account_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    name            TEXT NOT NULL,            -- "Bank", "VAT Control", "Prepayments" etc.
    slug            TEXT NOT NULL,
    description     TEXT,
    reconciliation_logic JSONB DEFAULT '{}',  -- rules engine config
    warning_rules   JSONB DEFAULT '[]',       -- array of rule definitions
    is_system       BOOLEAN NOT NULL DEFAULT false,  -- seeded templates
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organisation_id, slug)
);

CREATE TABLE template_checklist_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     UUID NOT NULL REFERENCES account_templates(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    description     TEXT,
    is_required     BOOLEAN NOT NULL DEFAULT true,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    evidence_required BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- RECONCILIATION PERIODS & ACCOUNTS
-- ============================================================

CREATE TABLE reconciliation_periods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    period_year     INTEGER NOT NULL,
    period_month    INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'in_progress', 'ready_for_review', 'approved', 'reopened')),
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_by       UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, period_year, period_month)
);

CREATE TABLE reconciliation_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id       UUID NOT NULL REFERENCES reconciliation_periods(id),
    xero_account_id TEXT NOT NULL,            -- Xero's account UUID
    account_code    TEXT,                     -- e.g. "1000"
    account_name    TEXT NOT NULL,
    account_type    TEXT NOT NULL,            -- "BANK", "CURRLIAB", etc (from Xero)
    template_id     UUID REFERENCES account_templates(id),  -- mapped template
    balance         NUMERIC(18,2) NOT NULL,   -- closing balance for this period
    prior_balance   NUMERIC(18,2),            -- prior month closing balance
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'in_progress', 'ready_for_review', 'approved', 'reopened')),
    prepared_by     UUID REFERENCES users(id),
    approved_by     UUID REFERENCES users(id),
    approved_at     TIMESTAMPTZ,
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (period_id, xero_account_id)
);

-- Transactions pulled from Xero for each account in a period
CREATE TABLE account_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    xero_line_item_id TEXT,                   -- Xero journal line ID
    xero_journal_id TEXT,                     -- Xero journal/invoice/bill ID
    transaction_date DATE NOT NULL,
    description     TEXT,
    reference       TEXT,
    contact_name    TEXT,
    debit           NUMERIC(18,2) DEFAULT 0,
    credit          NUMERIC(18,2) DEFAULT 0,
    source_type     TEXT,                     -- "ACCREC", "ACCPAY", "MANJOURNAL" etc.
    raw_data        JSONB,                    -- full Xero payload for auditability
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_account_transactions_recon ON account_transactions(recon_account_id);
CREATE INDEX idx_account_transactions_xero ON account_transactions(xero_journal_id);

-- ============================================================
-- NOTES, DOCUMENTS, CHECKLISTS, FLAGS
-- ============================================================

CREATE TABLE account_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    note_type       TEXT NOT NULL CHECK (note_type IN ('prep', 'review', 'general')),
    content         TEXT NOT NULL,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE account_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    file_name       TEXT NOT NULL,
    file_key        TEXT NOT NULL,             -- S3 key
    file_size       INTEGER,
    mime_type       TEXT,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE checklist_responses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    checklist_item_id UUID NOT NULL REFERENCES template_checklist_items(id),
    is_checked      BOOLEAN NOT NULL DEFAULT false,
    evidence_doc_id UUID REFERENCES account_documents(id),
    notes           TEXT,
    completed_by    UUID REFERENCES users(id),
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (recon_account_id, checklist_item_id)
);

CREATE TABLE account_flags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    flag_type       TEXT NOT NULL,            -- "balance_mismatch", "old_accrual", "missing_evidence" etc.
    severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    message         TEXT NOT NULL,
    auto_generated  BOOLEAN NOT NULL DEFAULT false,
    resolved        BOOLEAN NOT NULL DEFAULT false,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- IMMUTABLE SNAPSHOTS (created on approval)
-- ============================================================

CREATE TABLE reconciliation_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    snapshot_version INTEGER NOT NULL DEFAULT 1,  -- increments on re-approval
    balance_at_approval NUMERIC(18,2) NOT NULL,
    transaction_count INTEGER NOT NULL,
    transaction_hash TEXT NOT NULL,            -- SHA-256 of sorted transaction IDs+amounts
    prepared_by     UUID NOT NULL REFERENCES users(id),
    approved_by     UUID NOT NULL REFERENCES users(id),
    approved_at     TIMESTAMPTZ NOT NULL,
    ai_summary      TEXT,                     -- AI-generated summary at time of approval
    metadata        JSONB DEFAULT '{}',       -- rule results, additional context
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    -- NO updated_at — snapshots are immutable
);

CREATE TABLE snapshot_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id     UUID NOT NULL REFERENCES reconciliation_snapshots(id),
    xero_line_item_id TEXT,
    xero_journal_id TEXT,
    transaction_date DATE NOT NULL,
    description     TEXT,
    reference       TEXT,
    contact_name    TEXT,
    debit           NUMERIC(18,2) DEFAULT 0,
    credit          NUMERIC(18,2) DEFAULT 0,
    source_type     TEXT,
    raw_data        JSONB
);

CREATE TABLE snapshot_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id     UUID NOT NULL REFERENCES reconciliation_snapshots(id),
    file_name       TEXT NOT NULL,
    file_key        TEXT NOT NULL,
    uploaded_by     UUID NOT NULL REFERENCES users(id)
);

CREATE TABLE snapshot_checklist (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id     UUID NOT NULL REFERENCES reconciliation_snapshots(id),
    checklist_label TEXT NOT NULL,
    is_checked      BOOLEAN NOT NULL,
    evidence_file_key TEXT,
    notes           TEXT
);

CREATE TABLE snapshot_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id     UUID NOT NULL REFERENCES reconciliation_snapshots(id),
    note_type       TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE snapshot_flags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id     UUID NOT NULL REFERENCES reconciliation_snapshots(id),
    flag_type       TEXT NOT NULL,
    severity        TEXT NOT NULL,
    message         TEXT NOT NULL,
    resolved        BOOLEAN NOT NULL
);

-- ============================================================
-- LEDGER CHANGE DETECTION
-- ============================================================

CREATE TABLE ledger_change_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    snapshot_id     UUID NOT NULL REFERENCES reconciliation_snapshots(id),
    change_type     TEXT NOT NULL CHECK (change_type IN (
        'balance_changed', 'transaction_added', 'transaction_removed', 'transaction_modified'
    )),
    previous_value  JSONB,
    current_value   JSONB,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ
);

-- ============================================================
-- PREPAYMENT SCHEDULES (Phase 2, schema ready)
-- ============================================================

CREATE TABLE prepayment_schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    supplier        TEXT NOT NULL,
    description     TEXT,
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    total_amount    NUMERIC(18,2) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    evidence_doc_id UUID REFERENCES account_documents(id),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ACCRUALS (Phase 2, schema ready)
-- ============================================================

CREATE TABLE accrual_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recon_account_id UUID NOT NULL REFERENCES reconciliation_accounts(id),
    description     TEXT NOT NULL,
    amount          NUMERIC(18,2) NOT NULL,
    raised_in_month DATE NOT NULL,            -- first of month
    reversal_month  DATE,                     -- first of month
    is_reversed     BOOLEAN NOT NULL DEFAULT false,
    evidence_doc_id UUID REFERENCES account_documents(id),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- AUDIT LOG (application-level audit trail)
-- ============================================================

CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    user_id         UUID REFERENCES users(id),
    entity_type     TEXT NOT NULL,            -- "reconciliation_account", "snapshot", etc.
    entity_id       UUID NOT NULL,
    action          TEXT NOT NULL,            -- "approved", "reopened", "status_changed" etc.
    details         JSONB DEFAULT '{}',
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_org ON audit_log(organisation_id, created_at);
```

### 2.4 Key Schema Decisions Explained

**Why duplicate data into snapshot tables instead of just referencing the live tables?**

This is the most important design choice. Live tables (`account_transactions`, `account_notes`, etc.) are mutable — Xero data gets re-synced, notes get edited, documents get replaced. The snapshot must be a frozen copy of reality at approval time. If you reference live data, a later Xero sync silently changes your "approved" state. That defeats the entire control purpose.

The storage cost is trivial. The integrity guarantee is critical.

**Why `transaction_hash` on snapshots?**

This is a fast integrity check. When the ledger-change detection job runs, it:
1. Pulls current transactions for the account from Xero
2. Computes the same hash (sorted transaction IDs + amounts → SHA-256)
3. Compares to the snapshot hash
4. If different → flag immediately, without needing row-by-row comparison first

Row-by-row comparison then runs to identify *what* changed.

**Why JSONB for `reconciliation_logic` and `warning_rules`?**

Template rules will evolve. Encoding them as rigid columns would require schema migrations for every rule change. JSONB gives you a config-driven rule engine with no migrations. Example:

```json
{
  "warning_rules": [
    {
      "id": "stale_accrual",
      "condition": "accrual_age_months > 3 AND NOT is_reversed",
      "severity": "warning",
      "message": "Accrual is over 3 months old and has not been reversed"
    }
  ]
}
```

The application interprets these rules. This is safer than putting logic in the database.

---

## 3. Risks & Design Flaws Identified

### 3.1 Xero API Rate Limits — This Will Bite You

Xero enforces:
- **60 calls per minute** per tenant (the one that matters)
- **5,000 calls per day** per tenant

A full balance sheet pull with transaction details for, say, 30 accounts could consume 30+ API calls (one for the balance sheet, one per account for journals). If you have 20 clients, a full sync run = 600+ calls = 10 minutes minimum just waiting for rate limits.

**Mitigation:**
- Background job queue with rate-limited workers (BullMQ rate limiter)
- Incremental sync: after first full pull, use Xero's `If-Modified-Since` and journal number tracking to only pull changes
- Cache aggressively — store all Xero responses in `raw_data` JSONB columns
- Never block the UI on a sync — show last-synced timestamp and allow manual refresh

### 3.2 Xero Token Refresh Race Condition

Xero OAuth tokens expire every 30 minutes. If two background jobs for the same client try to refresh simultaneously, one gets a new token and the other's refresh token becomes invalid (Xero invalidates used refresh tokens).

**Mitigation:**
- Central token refresh with a Redis lock per `xero_connection.id`
- Single refresh function that acquires lock, checks if token was already refreshed by another process, refreshes if needed
- All Xero API calls go through a single `xeroClient(clientId)` factory that handles this

### 3.3 Snapshot Integrity — What if S3 Files Are Deleted?

Your snapshot references `file_key` in S3. If someone deletes the file, the snapshot is incomplete.

**Mitigation:**
- Snapshot documents should be copied to a separate S3 prefix (`/snapshots/{snapshot_id}/`) at approval time
- Or use S3 Object Lock (immutable storage) for snapshot files
- For V1, just copy the file to a snapshot prefix. Simple and effective.

### 3.4 Multi-Org Isolation — Application Bug = Data Leak

You're relying on application-level org isolation. One missed `WHERE organisation_id = ?` and you've leaked data between firms.

**Mitigation:**
- Drizzle middleware or wrapper that automatically injects `organisation_id` filter on all queries
- Use a `withOrg(orgId)` query builder wrapper
- Integration tests that verify org isolation for every query
- Consider: Postgres Row-Level Security as a belt-and-suspenders measure (not primary, but backup)

### 3.5 Workflow State Machine — Race Conditions

Two users could simultaneously change an account's status. Without proper controls:
- Junior marks "Ready for Review" while Manager is already reviewing
- Manager approves while Junior is still editing

**Mitigation:**
- Optimistic locking: `updated_at` check on status transitions
- Status transition validation at the database level (application enforces valid transitions)
- Valid transitions:

```
draft → in_progress (junior starts work)
in_progress → ready_for_review (junior submits)
ready_for_review → in_progress (manager returns for rework)
ready_for_review → approved (manager approves → creates snapshot)
approved → reopened (system detects change, or manager manually reopens)
reopened → in_progress (junior starts rework)
```

### 3.6 Period-Level vs Account-Level Status

Your spec mentions both. Be clear: **the period status should be derived from its accounts, not independently managed.** A period is "approved" only when all its accounts are approved. Don't maintain a separate status that can drift.

**Recommendation:** `reconciliation_periods.status` is a computed/derived field. Either calculate it on read, or update it via a trigger/hook when any child account status changes.

---

## 4. Improvements & Suggestions

### 4.1 Add an Application-Level Audit Log

You mentioned audit trail. The schema above includes an `audit_log` table. Every status change, approval, reopen, document upload, note edit, and Xero sync should write an audit entry. This is cheap to implement and invaluable for governance.

### 4.2 Soft-Delete Pattern for Documents and Notes

Don't hard-delete anything in V1. Add `deleted_at` / `deleted_by` columns. Auditors will ask "what was there before?" and you need to answer.

### 4.3 Xero Webhook Integration (Post-V1)

Instead of polling for ledger changes, Xero supports webhooks. Register for `INVOICE`, `BANK_TRANSACTION`, and `MANUAL_JOURNAL` events. When fired, queue a targeted re-check for affected accounts. This replaces or supplements your cron-based change detection.

For V1, cron polling is fine. Plan for webhooks in V2.

### 4.4 Account-Template Auto-Mapping

When you pull accounts from Xero, auto-map them to templates based on Xero's `account_type` field:

| Xero Type | Template |
|---|---|
| BANK | Bank |
| CURRLIAB (name contains "VAT") | VAT Control |
| CURRLIAB (name contains "Accrual") | Accruals |
| CURRASS (name contains "Prepay") | Prepayments |
| FIXED | Fixed Assets |

Let users override. But default mapping saves setup time for each new client.

### 4.5 Bulk Operations

Managers will want to "approve all accounts that are ready for review" in one click. Build this into the UI from day one. It's a simple loop with the same validation per account, but the UX matters.

---

## 5. What's Missing From Your Spec

### 5.1 Xero Disconnect / Reconnect Flow

What happens when a Xero token expires permanently (user revokes access in Xero)? You need:
- Status indicator on client card showing connection health
- Reconnect flow without losing historical data
- Graceful handling of failed syncs (don't crash the whole period)

### 5.2 Client Onboarding Flow

How does a new client get set up?
1. Admin creates client
2. Admin connects Xero (OAuth flow)
3. System pulls Chart of Accounts
4. Admin/Manager maps accounts to templates (with auto-suggestions)
5. First period is opened

This flow needs to be explicit in the UI.

### 5.3 Period Opening/Closing Ceremony

Who opens a new period? Is it automatic (first of each month) or manual? I recommend:
- Manual opening by Manager or Admin
- On open: system pulls latest Xero balance sheet data
- Prior month balances auto-populated from previous period's approved balances (if they exist)

### 5.4 Re-Approval History

When an account goes through: Approved → Reopened → Approved again, you now have two snapshots (version 1 and version 2). The UI should show the full history of approvals per account, with diff capability between snapshot versions.

### 5.5 Reporting / Dashboard

Not mentioned but you'll need:
- Period summary: how many accounts drafted / in progress / approved
- Ageing: how long accounts have been sitting in each status
- Client overview: which clients are behind on month-end
- Flag summary: outstanding unresolved flags across all clients

### 5.6 Email / Notification

When a junior marks "Ready for Review," the manager should know. When a manager returns work, the junior should know. At minimum, in-app notifications. Email optional for V1.

---

## 6. Implementation Order (Phase 1 — Walking Skeleton)

Build in vertical slices. Each slice delivers working end-to-end functionality.

### Slice 1: Foundation
- [ ] Project setup (Next.js, Drizzle, Postgres, Tailwind, shadcn/ui)
- [ ] Database migration for core tables (orgs, users, org_users, clients)
- [ ] Auth (NextAuth with credentials provider)
- [ ] Role-based middleware
- [ ] Seed script: create Fin-House and Startup Accountancy orgs, admin users
- [ ] Layout: sidebar navigation, org switcher

### Slice 2: Client + Xero
- [ ] Client CRUD pages
- [ ] Xero OAuth flow (connect button → callback → store tokens)
- [ ] Token refresh logic with Redis lock
- [ ] Xero API wrapper (rate-limited, error-handled)
- [ ] Pull Chart of Accounts on connect

### Slice 3: Period + Balance Sheet
- [ ] Period management (open period for client + month)
- [ ] Balance sheet pull from Xero (background job)
- [ ] Account list page with balances, prior balances, status badges
- [ ] Account-to-template mapping (manual + auto-suggest)

### Slice 4: Account Drilldown
- [ ] Account detail page
- [ ] Transaction list (pulled from Xero)
- [ ] Notes (add/view, prep vs review)
- [ ] File upload to S3
- [ ] Checklist (based on template)
- [ ] Status transitions (Draft → In Progress → Ready for Review)

### Slice 5: Approval + Snapshots
- [ ] Manager approval action
- [ ] Snapshot creation (copy all live data to snapshot tables)
- [ ] Transaction hash generation
- [ ] Lock account on approval
- [ ] Snapshot view (read-only view of approved state)

### Slice 6: Ledger-Change Detection
- [ ] Background job: re-pull transactions for approved accounts
- [ ] Compare transaction hash to snapshot
- [ ] If changed: write to `ledger_change_log`, create flag, set account status to needs attention
- [ ] UI: show change detection alerts on dashboard
- [ ] Reopen flow (Manager action)

### Slice 7: Polish & Controls
- [ ] Audit log writes on all critical actions
- [ ] Period status derivation from account statuses
- [ ] Dashboard: period overview, flag summary
- [ ] User management (Admin CRUD for users + role assignment)
- [ ] Bulk approve action for managers
- [ ] Error handling and loading states throughout

---

## 7. File Structure

```
/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── (auth)/                   # Login, etc.
│   │   │   └── login/
│   │   ├── (dashboard)/              # Authenticated layout
│   │   │   ├── layout.tsx            # Sidebar, org context
│   │   │   ├── page.tsx              # Dashboard home
│   │   │   ├── clients/
│   │   │   │   ├── page.tsx          # Client list
│   │   │   │   ├── [clientId]/
│   │   │   │   │   ├── page.tsx      # Client detail
│   │   │   │   │   ├── connect-xero/ # Xero OAuth
│   │   │   │   │   └── periods/
│   │   │   │   │       └── [periodId]/
│   │   │   │   │           ├── page.tsx       # Balance sheet view
│   │   │   │   │           └── accounts/
│   │   │   │   │               └── [accountId]/
│   │   │   │   │                   └── page.tsx  # Account drilldown
│   │   │   ├── admin/
│   │   │   │   ├── users/
│   │   │   │   └── templates/
│   │   │   └── settings/
│   │   └── api/
│   │       ├── auth/                 # NextAuth routes
│   │       ├── xero/
│   │       │   ├── callback/         # OAuth callback
│   │       │   └── webhook/          # Future: Xero webhooks
│   │       └── upload/               # File upload endpoint
│   ├── lib/
│   │   ├── db/
│   │   │   ├── schema.ts            # Drizzle schema definitions
│   │   │   ├── migrations/           # SQL migrations
│   │   │   └── index.ts             # DB connection
│   │   ├── xero/
│   │   │   ├── client.ts            # Xero API wrapper
│   │   │   ├── auth.ts              # Token management
│   │   │   └── types.ts             # Xero response types
│   │   ├── auth/
│   │   │   ├── config.ts            # NextAuth config
│   │   │   └── middleware.ts         # Role checks
│   │   ├── storage/
│   │   │   └── s3.ts                # S3 upload/download
│   │   ├── jobs/
│   │   │   ├── queue.ts             # BullMQ setup
│   │   │   ├── sync-balance-sheet.ts
│   │   │   └── detect-changes.ts
│   │   ├── rules/
│   │   │   └── engine.ts            # Template rule evaluation
│   │   └── snapshots/
│   │       └── create.ts            # Snapshot creation logic
│   ├── components/
│   │   ├── ui/                       # shadcn/ui components
│   │   ├── layout/
│   │   │   ├── sidebar.tsx
│   │   │   └── org-switcher.tsx
│   │   ├── accounts/
│   │   ├── periods/
│   │   └── common/
│   └── actions/                      # Server Actions
│       ├── clients.ts
│       ├── periods.ts
│       ├── accounts.ts
│       ├── approval.ts
│       └── upload.ts
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── .env.example
└── docker-compose.yml                # Postgres + Redis for local dev
```

---

## 8. Security Considerations

| Concern | Mitigation |
|---|---|
| Xero tokens at rest | Encrypt `access_token` and `refresh_token` columns using application-level encryption (e.g., `aes-256-gcm` with a key from env var). Do not store in plaintext. |
| File uploads | Validate mime type server-side. Set max file size (10MB). Generate random S3 keys (no user-controlled paths). Serve via signed URLs, not public. |
| Session management | HTTPOnly, Secure, SameSite cookies via NextAuth. Short session expiry (8 hours for internal tool). |
| RBAC bypass | Middleware checks on every route. Server Actions validate role before executing. Never trust client-side role state. |
| SQL injection | Drizzle's parameterised queries handle this. Never interpolate user input into raw SQL. |
| Org isolation | Every DB query must include `organisation_id`. Middleware sets org context from session. Integration tests verify isolation. |

---

## 9. Summary of Recommendations

1. **Your stack choice is sound.** Next.js + Postgres + S3 is the right call for an internal tool of this complexity. No changes needed.
2. **Drop tRPC.** Server Actions are sufficient. Add an API layer only if/when needed.
3. **Use Drizzle over Prisma.** Lighter, better SQL control, excellent TypeScript types.
4. **Snapshots must be full copies, not references.** This is non-negotiable for your control requirements.
5. **Background jobs from day one.** Don't try to do Xero syncs in request handlers. You'll hit rate limits and timeouts.
6. **Build in vertical slices.** Each slice delivers working functionality. Don't build all the infrastructure first.
7. **Transaction hashing** for fast change detection. Row-by-row comparison for detail.
8. **Encrypt Xero tokens.** They're effectively keys to your clients' financial data.
9. **Audit log everything.** Cheap to implement, expensive to retrofit.
10. **Period status is derived, not independently managed.** Eliminates a class of bugs.
