/**
 * Next.js instrumentation hook — runs once when the server starts.
 * We use it to seed test data so it happens at runtime (where DATABASE_URL is available).
 */
export async function register() {
  // Only seed on the Node.js server, not during edge runtime
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await seedTestDataIfNeeded();
  }
}

async function seedTestDataIfNeeded() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("[seed] No DATABASE_URL, skipping test seed.");
    return;
  }

  try {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const pg = await import("postgres");
    const { eq } = await import("drizzle-orm");
    const schema = await import("./lib/db/schema");

    const client = pg.default(connectionString);
    const db = drizzle(client);

    // Run schema migrations (idempotent)
    await client`ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS item_date date`;
    await client`ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS gl_transaction_id uuid REFERENCES gl_transactions(id)`;

    // Bank reconciliation tables
    await client`
      CREATE TABLE IF NOT EXISTS bank_recon_statements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        recon_account_id uuid NOT NULL REFERENCES reconciliation_accounts(id) UNIQUE,
        statement_date date NOT NULL,
        statement_balance numeric(18, 2) NOT NULL,
        gl_balance numeric(18, 2) NOT NULL,
        currency varchar(3) NOT NULL DEFAULT 'GBP',
        document_file_name text,
        document_file_key text,
        status text NOT NULL DEFAULT 'pending',
        tolerance_used numeric(18, 2) NOT NULL DEFAULT '0',
        notes text,
        confirmed_by uuid REFERENCES users(id),
        confirmed_at timestamptz,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
    await client`
      CREATE TABLE IF NOT EXISTS bank_recon_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        recon_account_id uuid NOT NULL REFERENCES reconciliation_accounts(id),
        item_type text NOT NULL DEFAULT 'other',
        description text NOT NULL,
        amount numeric(18, 2) NOT NULL,
        transaction_date date,
        reference text,
        xero_transaction_id text,
        source text NOT NULL DEFAULT 'manual',
        is_ticked boolean NOT NULL DEFAULT false,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
    await client`CREATE INDEX IF NOT EXISTS idx_bank_recon_items_account ON bank_recon_items(recon_account_id)`;
    await client`CREATE INDEX IF NOT EXISTS idx_bank_recon_statements_account ON bank_recon_statements(recon_account_id)`;

    // AR Reconciliation tables
    await client`DO $$ BEGIN CREATE TYPE ar_recon_status AS ENUM ('draft', 'complete', 'reviewed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
    await client`DO $$ BEGIN CREATE TYPE ar_risk_flag AS ENUM ('none', 'watch', 'high'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
    await client`DO $$ BEGIN CREATE TYPE ar_aging_bucket AS ENUM ('current', '1_30', '31_60', '61_90', '90_plus'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
    await client`
      CREATE TABLE IF NOT EXISTS ar_reconciliations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        recon_account_id uuid NOT NULL REFERENCES reconciliation_accounts(id) UNIQUE,
        month_end_date date NOT NULL,
        ledger_balance numeric(18, 2) NOT NULL,
        aged_report_total numeric(18, 2),
        variance numeric(18, 2),
        status ar_recon_status NOT NULL DEFAULT 'draft',
        signed_off_by uuid REFERENCES users(id),
        signed_off_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
    await client`
      CREATE TABLE IF NOT EXISTS ar_invoice_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reconciliation_id uuid NOT NULL REFERENCES ar_reconciliations(id) ON DELETE CASCADE,
        xero_invoice_id text,
        invoice_number text,
        contact_name text NOT NULL,
        invoice_date date,
        due_date date,
        original_amount numeric(18, 2) NOT NULL,
        outstanding_amount numeric(18, 2) NOT NULL,
        aging_bucket ar_aging_bucket NOT NULL DEFAULT 'current',
        days_overdue integer NOT NULL DEFAULT 0,
        requires_comment boolean NOT NULL DEFAULT false,
        comment_text text,
        risk_flag ar_risk_flag NOT NULL DEFAULT 'none',
        reviewed boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
    await client`
      CREATE TABLE IF NOT EXISTS ar_audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id),
        invoice_snapshot_id uuid NOT NULL REFERENCES ar_invoice_snapshots(id) ON DELETE CASCADE,
        change_type text NOT NULL,
        previous_value text,
        new_value text,
        timestamp timestamptz NOT NULL DEFAULT now()
      )`;
    await client`ALTER TABLE ar_invoice_snapshots ADD COLUMN IF NOT EXISTS current_amount_due numeric(18, 2)`;
    await client`CREATE INDEX IF NOT EXISTS idx_ar_recon_account ON ar_reconciliations(recon_account_id)`;
    await client`CREATE INDEX IF NOT EXISTS idx_ar_snapshots_recon ON ar_invoice_snapshots(reconciliation_id)`;
    await client`CREATE INDEX IF NOT EXISTS idx_ar_snapshots_bucket ON ar_invoice_snapshots(aging_bucket)`;
    await client`CREATE INDEX IF NOT EXISTS idx_ar_audit_snapshot ON ar_audit_log(invoice_snapshot_id)`;
    await client`CREATE INDEX IF NOT EXISTS idx_ar_audit_user ON ar_audit_log(user_id)`;

    console.log("[seed] Schema migrations applied.");

    // Check if test clients already exist
    const existing = await db
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(eq(schema.clients.code, "ALPHA"))
      .limit(1);

    if (existing.length > 0) {
      console.log("[seed] Test clients already exist, applying data patches...");

      // Patch: fix Bravo Feb balance (10800 → 10799.50)
      await client`
        UPDATE reconciliation_accounts SET balance = '10799.50'
        WHERE account_name = 'PAYE Payable' AND balance = '10800.00'
          AND period_id IN (
            SELECT rp.id FROM reconciliation_periods rp
            JOIN clients c ON rp.client_id = c.id
            WHERE c.code = 'BRAVO' AND rp.period_month = 2 AND rp.period_year = 2026
          )`;

      // Patch: fix closing item description
      await client`
        UPDATE reconciliation_items SET description = 'Unpaid BF residual'
        WHERE description = 'Unpaid BF residual (Nov PAYE)'`;

      console.log("[seed] Patches applied.");

      // Check if bank recon test clients need to be created
      const deltaExists = await db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.code, "DELTA"))
        .limit(1);

      if (deltaExists.length === 0) {
        console.log("[seed] Creating bank recon test clients...");
        // Fall through to create Delta/Echo below
      } else {
        console.log("[seed] Bank recon test clients already exist.");
        await client.end();
        return;
      }
    }

    // Get admin user
    const [adminUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "james@fin-house.co.uk"))
      .limit(1);

    if (!adminUser) {
      console.log("[seed] Admin user not found, skipping test seed.");
      await client.end();
      return;
    }

    const userId = adminUser.id;
    console.log(`[seed] Seeding test data with admin user: ${adminUser.name}`);

    const PAYE_ACCOUNT_CODE = "820";
    const PAYE_ACCOUNT_NAME = "PAYE Payable";
    const PAYE_XERO_ID_PREFIX = "test-paye-";

    // Helper to create a company with PAYE data
    async function createCompany(opts: {
      name: string;
      code: string;
      xeroAccountId: string;
      months: {
        year: number;
        month: number;
        balance: string;
        priorBalance: string | null;
        glMovements: {
          date: string;
          description: string;
          source: string;
          debit: string;
          credit: string;
          contact?: string;
          reference?: string;
        }[];
        closingItems: { description: string; amount: string }[];
      }[];
    }) {
      const [newClient] = await db
        .insert(schema.clients)
        .values({ name: opts.name, code: opts.code, createdBy: userId })
        .onConflictDoNothing()
        .returning();

      if (!newClient) {
        console.log(`[seed]   ${opts.code} already exists, skipping.`);
        return;
      }
      console.log(`[seed]   Created client: ${opts.name}`);

      await db.insert(schema.accountReconConfig).values({
        clientId: newClient.id,
        xeroAccountId: opts.xeroAccountId,
        accountName: PAYE_ACCOUNT_NAME,
        reconModule: "pensions_payable",
      });

      const [upload] = await db
        .insert(schema.glUploads)
        .values({
          clientId: newClient.id,
          fileName: `${opts.code}-test-gl.xlsx`,
          uploadedBy: userId,
          rowCount: 0,
          accountCount: 1,
          dateFrom: opts.months[0]
            ? `${opts.months[0].year}-${String(opts.months[0].month).padStart(2, "0")}-01`
            : null,
          dateTo: opts.months[opts.months.length - 1]
            ? `${opts.months[opts.months.length - 1].year}-${String(opts.months[opts.months.length - 1].month).padStart(2, "0")}-28`
            : null,
        })
        .returning();

      let totalGlRows = 0;

      for (const m of opts.months) {
        const [period] = await db
          .insert(schema.reconciliationPeriods)
          .values({
            clientId: newClient.id,
            periodYear: m.year,
            periodMonth: m.month,
            status: "in_progress",
            openedBy: userId,
          })
          .returning();

        const [account] = await db
          .insert(schema.reconciliationAccounts)
          .values({
            periodId: period.id,
            xeroAccountId: opts.xeroAccountId,
            accountCode: PAYE_ACCOUNT_CODE,
            accountName: PAYE_ACCOUNT_NAME,
            accountType: "LIABILITY",
            balance: m.balance,
            priorBalance: m.priorBalance,
            status: "in_progress",
          })
          .returning();

        for (const gl of m.glMovements) {
          await db.insert(schema.glTransactions).values({
            uploadId: upload.id,
            clientId: newClient.id,
            accountCode: PAYE_ACCOUNT_CODE,
            accountName: PAYE_ACCOUNT_NAME,
            transactionDate: gl.date,
            source: gl.source,
            description: gl.description,
            reference: gl.reference || null,
            contact: gl.contact || null,
            debit: gl.debit,
            credit: gl.credit,
          });
          totalGlRows++;
        }

        for (const item of m.closingItems) {
          await db.insert(schema.reconciliationItems).values({
            reconAccountId: account.id,
            description: item.description,
            amount: item.amount,
            createdBy: userId,
          });
        }
      }

      await db
        .update(schema.glUploads)
        .set({ rowCount: totalGlRows })
        .where(eq(schema.glUploads.id, upload.id));
    }

    // ── Alpha Pensions Ltd — single exact payment each month ──
    await createCompany({
      name: "Alpha Pensions Ltd",
      code: "ALPHA",
      xeroAccountId: `${PAYE_XERO_ID_PREFIX}alpha`,
      months: [
        {
          year: 2025, month: 11, balance: "5000.00", priorBalance: null,
          glMovements: [
            { date: "2025-11-30", description: "November PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "5000.00", reference: "JNL-001" },
          ],
          closingItems: [{ description: "November PAYE accrual", amount: "5000.00" }],
        },
        {
          year: 2025, month: 12, balance: "5200.00", priorBalance: "5000.00",
          glMovements: [
            { date: "2025-12-15", description: "PAYE payment to HMRC", source: "BANKSPEND", debit: "5000.00", credit: "0", contact: "HMRC", reference: "BACS-1201" },
            { date: "2025-12-31", description: "December PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "5200.00", reference: "JNL-012" },
          ],
          closingItems: [{ description: "December PAYE accrual", amount: "5200.00" }],
        },
        {
          year: 2026, month: 1, balance: "5200.00", priorBalance: "5200.00",
          glMovements: [
            { date: "2026-01-19", description: "PAYE payment to HMRC", source: "BANKSPEND", debit: "5200.00", credit: "0", contact: "HMRC", reference: "BACS-0119" },
            { date: "2026-01-31", description: "January PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "5200.00", reference: "JNL-013" },
          ],
          closingItems: [{ description: "January PAYE accrual", amount: "5200.00" }],
        },
        {
          year: 2026, month: 2, balance: "5350.00", priorBalance: "5200.00",
          glMovements: [
            { date: "2026-02-17", description: "PAYE payment to HMRC", source: "BANKSPEND", debit: "5200.00", credit: "0", contact: "HMRC", reference: "BACS-0217" },
            { date: "2026-02-28", description: "February PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "5350.00", reference: "JNL-014" },
          ],
          closingItems: [],
        },
      ],
    });

    // ── Bravo Services Ltd — multiple payments clear BF ──
    await createCompany({
      name: "Bravo Services Ltd",
      code: "BRAVO",
      xeroAccountId: `${PAYE_XERO_ID_PREFIX}bravo`,
      months: [
        {
          year: 2025, month: 11, balance: "10000.00", priorBalance: null,
          glMovements: [
            { date: "2025-11-30", description: "November PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "10000.00" },
          ],
          closingItems: [{ description: "November PAYE accrual", amount: "10000.00" }],
        },
        {
          year: 2025, month: 12, balance: "10500.00", priorBalance: "10000.00",
          glMovements: [
            { date: "2025-12-05", description: "PAYE payment (week 1-2)", source: "BANKSPEND", debit: "5000.00", credit: "0", contact: "HMRC", reference: "BACS-1205" },
            { date: "2025-12-19", description: "PAYE payment (week 3-4)", source: "BANKSPEND", debit: "5000.00", credit: "0", contact: "HMRC", reference: "BACS-1219" },
            { date: "2025-12-31", description: "December PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "10500.00", reference: "JNL-112" },
          ],
          closingItems: [{ description: "December PAYE accrual", amount: "10500.00" }],
        },
        {
          year: 2026, month: 1, balance: "10500.00", priorBalance: "10500.00",
          glMovements: [
            { date: "2026-01-07", description: "PAYE payment (week 1)", source: "BANKSPEND", debit: "3500.00", credit: "0", contact: "HMRC", reference: "BACS-0107" },
            { date: "2026-01-14", description: "PAYE payment (week 2)", source: "BANKSPEND", debit: "3500.00", credit: "0", contact: "HMRC", reference: "BACS-0114" },
            { date: "2026-01-21", description: "PAYE payment (week 3)", source: "BANKSPEND", debit: "3500.00", credit: "0", contact: "HMRC", reference: "BACS-0121" },
            { date: "2026-01-31", description: "January PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "10500.00", reference: "JNL-113" },
          ],
          closingItems: [{ description: "January PAYE accrual", amount: "10500.00" }],
        },
        {
          year: 2026, month: 2, balance: "10799.50", priorBalance: "10500.00",
          glMovements: [
            { date: "2026-02-10", description: "PAYE payment (main)", source: "BANKSPEND", debit: "7000.00", credit: "0", contact: "HMRC", reference: "BACS-0210" },
            { date: "2026-02-20", description: "PAYE payment (balance)", source: "BANKSPEND", debit: "3500.50", credit: "0", contact: "HMRC", reference: "BACS-0220" },
            { date: "2026-02-28", description: "February PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "10800.00", reference: "JNL-114" },
          ],
          closingItems: [],
        },
      ],
    });

    // ── Charlie Holdings Ltd — partial payment / residual ──
    await createCompany({
      name: "Charlie Holdings Ltd",
      code: "CHARLIE",
      xeroAccountId: `${PAYE_XERO_ID_PREFIX}charlie`,
      months: [
        {
          year: 2025, month: 11, balance: "8000.00", priorBalance: null,
          glMovements: [
            { date: "2025-11-30", description: "November PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "8000.00" },
          ],
          closingItems: [{ description: "November PAYE accrual", amount: "8000.00" }],
        },
        {
          year: 2025, month: 12, balance: "10500.00", priorBalance: "8000.00",
          glMovements: [
            { date: "2025-12-15", description: "PAYE part-payment to HMRC", source: "BANKSPEND", debit: "6000.00", credit: "0", contact: "HMRC", reference: "BACS-C1215" },
            { date: "2025-12-31", description: "December PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "8500.00", reference: "JNL-C12" },
          ],
          closingItems: [
            { description: "December PAYE accrual", amount: "8500.00" },
            { description: "Unpaid BF residual", amount: "2000.00" },
          ],
        },
        {
          year: 2026, month: 1, balance: "8500.00", priorBalance: "10500.00",
          glMovements: [
            { date: "2026-01-15", description: "PAYE payment (Dec accrual)", source: "BANKSPEND", debit: "8500.00", credit: "0", contact: "HMRC", reference: "BACS-C0115" },
            { date: "2026-01-16", description: "PAYE payment (Nov arrears)", source: "BANKSPEND", debit: "2000.00", credit: "0", contact: "HMRC", reference: "BACS-C0116" },
            { date: "2026-01-31", description: "January PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "8500.00", reference: "JNL-C01" },
          ],
          closingItems: [{ description: "January PAYE accrual", amount: "8500.00" }],
        },
        {
          year: 2026, month: 2, balance: "9000.63", priorBalance: "8500.00",
          glMovements: [
            { date: "2026-02-14", description: "PAYE payment to HMRC", source: "BANKSPEND", debit: "8499.37", credit: "0", contact: "HMRC", reference: "BACS-C0214" },
            { date: "2026-02-28", description: "February PAYE accrual", source: "MANJOURNAL", debit: "0", credit: "9000.00", reference: "JNL-C02" },
          ],
          closingItems: [],
        },
      ],
    });

    // ══════════════════════════════════════════════════════════════
    // BANK RECONCILIATION TEST DATA
    // ══════════════════════════════════════════════════════════════

    // Delta Trading Ltd — GBP & USD bank accounts that match exactly
    const [deltaClient] = await db
      .insert(schema.clients)
      .values({ name: "Delta Trading Ltd", code: "DELTA", createdBy: userId })
      .onConflictDoNothing()
      .returning();

    if (deltaClient) {
      console.log(`[seed]   Created client: Delta Trading Ltd`);

      for (const month of [1, 2]) {
        const [period] = await db
          .insert(schema.reconciliationPeriods)
          .values({
            clientId: deltaClient.id,
            periodYear: 2026,
            periodMonth: month,
            status: "in_progress",
            openedBy: userId,
          })
          .returning();

        const gbpBal: Record<number, string> = { 1: "45230.67", 2: "52841.33" };
        const gbpPrior: Record<number, string | null> = { 1: null, 2: "45230.67" };
        await db.insert(schema.reconciliationAccounts).values({
          periodId: period.id,
          xeroAccountId: "test-bank-delta-gbp",
          accountCode: "090",
          accountName: "Business Current Account",
          accountType: "BANK",
          balance: gbpBal[month],
          priorBalance: gbpPrior[month],
          status: "in_progress",
        });

        const usdBal: Record<number, string> = { 1: "18500.00", 2: "22150.50" };
        const usdPrior: Record<number, string | null> = { 1: null, 2: "18500.00" };
        await db.insert(schema.reconciliationAccounts).values({
          periodId: period.id,
          xeroAccountId: "test-bank-delta-usd",
          accountCode: "091",
          accountName: "USD Dollar Account",
          accountType: "BANK",
          balance: usdBal[month],
          priorBalance: usdPrior[month],
          status: "in_progress",
        });
      }

      await db.insert(schema.accountReconConfig).values([
        {
          clientId: deltaClient.id,
          xeroAccountId: "test-bank-delta-gbp",
          accountName: "Business Current Account",
          reconModule: "bank",
        },
        {
          clientId: deltaClient.id,
          xeroAccountId: "test-bank-delta-usd",
          accountName: "USD Dollar Account",
          reconModule: "bank",
        },
      ]);
    }

    // Echo Imports Ltd — bank with mismatches (unpresented cheques)
    const [echoClient] = await db
      .insert(schema.clients)
      .values({ name: "Echo Imports Ltd", code: "ECHO", createdBy: userId })
      .onConflictDoNothing()
      .returning();

    if (echoClient) {
      console.log(`[seed]   Created client: Echo Imports Ltd`);

      for (const month of [1, 2]) {
        const [period] = await db
          .insert(schema.reconciliationPeriods)
          .values({
            clientId: echoClient.id,
            periodYear: 2026,
            periodMonth: month,
            status: "in_progress",
            openedBy: userId,
          })
          .returning();

        const balances: Record<number, string> = { 1: "67890.50", 2: "71250.00" };
        const prior: Record<number, string | null> = { 1: null, 2: "67890.50" };
        await db.insert(schema.reconciliationAccounts).values({
          periodId: period.id,
          xeroAccountId: "test-bank-echo-gbp",
          accountCode: "090",
          accountName: "Business Current Account",
          accountType: "BANK",
          balance: balances[month],
          priorBalance: prior[month],
          status: "in_progress",
        });
      }

      await db.insert(schema.accountReconConfig).values({
        clientId: echoClient.id,
        xeroAccountId: "test-bank-echo-gbp",
        accountName: "Business Current Account",
        reconModule: "bank",
      });
    }

    console.log("[seed] Test data seeded successfully (5 companies: 3 pensions + 2 bank).");
    await client.end();
  } catch (err) {
    console.error("[seed] Test seed failed:", err);
    // Don't crash the server — just log and continue
  }
}
