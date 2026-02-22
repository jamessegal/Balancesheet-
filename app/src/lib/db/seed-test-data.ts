/**
 * Seed script: 3 dummy companies with PAYE Payable data for Dec, Jan, Feb.
 *
 * Company A (Alpha Pensions Ltd)  — single exact payment clears BF each month
 * Company B (Bravo Services Ltd)  — multiple payments clear BF (exact & near)
 * Company C (Charlie Holdings Ltd)— partial payment / residual / rounding
 *
 * Run:  npx tsx src/lib/db/seed-test-data.ts
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  users,
  clients,
  reconciliationPeriods,
  reconciliationAccounts,
  reconciliationItems,
  glUploads,
  glTransactions,
  accountReconConfig,
} from "./schema";

const PAYE_ACCOUNT_NAME = "PAYE Payable";
const PAYE_ACCOUNT_CODE = "820";
const PAYE_XERO_ID_PREFIX = "test-paye-";

async function seedTestData() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = postgres(connectionString);
  const db = drizzle(client);

  // ── Get the admin user ──
  const [adminUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "james@fin-house.co.uk"))
    .limit(1);

  if (!adminUser) {
    console.error("Admin user not found. Run the base seed first.");
    await client.end();
    process.exit(1);
  }

  const userId = adminUser.id;
  console.log(`Using admin user: ${adminUser.name} (${adminUser.id})`);

  // ════════════════════════════════════════════════════════════════
  // Helper: create a full company with 3 months of PAYE data
  // ════════════════════════════════════════════════════════════════
  async function createCompany(opts: {
    name: string;
    code: string;
    xeroAccountId: string;
    // Each month: { year, month, balance, priorBalance, glMovements, closingItems }
    months: {
      year: number;
      month: number;
      balance: string; // closing balance per BS
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
    // 1. Create client
    const [newClient] = await db
      .insert(clients)
      .values({
        name: opts.name,
        code: opts.code,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();

    if (!newClient) {
      console.log(`  Client ${opts.code} already exists, skipping.`);
      return;
    }
    console.log(`  Created client: ${opts.name} (${newClient.id})`);

    // 2. Set recon config for this client's PAYE account
    await db.insert(accountReconConfig).values({
      clientId: newClient.id,
      xeroAccountId: opts.xeroAccountId,
      accountName: PAYE_ACCOUNT_NAME,
      reconModule: "pensions_payable",
    });

    // 3. Create a GL upload record (needed as parent for gl_transactions)
    const [upload] = await db
      .insert(glUploads)
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

    // 4. Create periods, accounts, GL movements, and closing items
    for (const m of opts.months) {
      const [period] = await db
        .insert(reconciliationPeriods)
        .values({
          clientId: newClient.id,
          periodYear: m.year,
          periodMonth: m.month,
          status: "in_progress",
          openedBy: userId,
        })
        .returning();

      const [account] = await db
        .insert(reconciliationAccounts)
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

      // GL movements
      for (const gl of m.glMovements) {
        await db.insert(glTransactions).values({
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

      // Closing items (these become BF for next month)
      for (const item of m.closingItems) {
        await db.insert(reconciliationItems).values({
          reconAccountId: account.id,
          description: item.description,
          amount: item.amount,
          createdBy: userId,
        });
      }

      const monthLabel = `${m.year}-${String(m.month).padStart(2, "0")}`;
      console.log(
        `    ${monthLabel}: balance=${m.balance}, ${m.glMovements.length} GL movements, ${m.closingItems.length} closing items`
      );
    }

    // Update GL upload row count
    await db
      .update(glUploads)
      .set({ rowCount: totalGlRows })
      .where(eq(glUploads.id, upload.id));
  }

  // ════════════════════════════════════════════════════════════════
  // COMPANY A: Alpha Pensions Ltd — Single exact payment each month
  // ════════════════════════════════════════════════════════════════
  console.log("\n── Company A: Alpha Pensions Ltd (single exact match) ──");
  await createCompany({
    name: "Alpha Pensions Ltd",
    code: "ALPHA",
    xeroAccountId: `${PAYE_XERO_ID_PREFIX}alpha`,
    months: [
      // ── November (prior period — just closing items, no GL needed) ──
      {
        year: 2025,
        month: 11,
        balance: "5000.00",
        priorBalance: null,
        glMovements: [
          {
            date: "2025-11-30",
            description: "November PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "5000.00",
            reference: "JNL-001",
          },
        ],
        closingItems: [
          { description: "November PAYE accrual", amount: "5000.00" },
        ],
      },
      // ── December: BF 5000, exact payment 5000, new accrual 5200 ──
      {
        year: 2025,
        month: 12,
        balance: "5200.00",
        priorBalance: "5000.00",
        glMovements: [
          {
            date: "2025-12-15",
            description: "PAYE payment to HMRC",
            source: "BANKSPEND",
            debit: "5000.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-1201",
          },
          {
            date: "2025-12-31",
            description: "December PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "5200.00",
            reference: "JNL-012",
          },
        ],
        closingItems: [
          { description: "December PAYE accrual", amount: "5200.00" },
        ],
      },
      // ── January: BF 5200, exact payment 5200, new accrual 5200 ──
      {
        year: 2026,
        month: 1,
        balance: "5200.00",
        priorBalance: "5200.00",
        glMovements: [
          {
            date: "2026-01-19",
            description: "PAYE payment to HMRC",
            source: "BANKSPEND",
            debit: "5200.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-0119",
          },
          {
            date: "2026-01-31",
            description: "January PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "5200.00",
            reference: "JNL-013",
          },
        ],
        closingItems: [
          { description: "January PAYE accrual", amount: "5200.00" },
        ],
      },
      // ── February: BF 5200, exact payment 5200, new accrual 5350 ──
      {
        year: 2026,
        month: 2,
        balance: "5350.00",
        priorBalance: "5200.00",
        glMovements: [
          {
            date: "2026-02-17",
            description: "PAYE payment to HMRC",
            source: "BANKSPEND",
            debit: "5200.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-0217",
          },
          {
            date: "2026-02-28",
            description: "February PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "5350.00",
            reference: "JNL-014",
          },
        ],
        // Feb closing items left EMPTY — user needs to reconcile
        closingItems: [],
      },
    ],
  });

  // ════════════════════════════════════════════════════════════════
  // COMPANY B: Bravo Services Ltd — Multiple payments clear BF
  // ════════════════════════════════════════════════════════════════
  console.log("\n── Company B: Bravo Services Ltd (multiple payments) ──");
  await createCompany({
    name: "Bravo Services Ltd",
    code: "BRAVO",
    xeroAccountId: `${PAYE_XERO_ID_PREFIX}bravo`,
    months: [
      // ── November (prior) ──
      {
        year: 2025,
        month: 11,
        balance: "10000.00",
        priorBalance: null,
        glMovements: [
          {
            date: "2025-11-30",
            description: "November PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "10000.00",
          },
        ],
        closingItems: [
          { description: "November PAYE accrual", amount: "10000.00" },
        ],
      },
      // ── December: BF 10000, two payments of 5000 each, new accrual 10500 ──
      {
        year: 2025,
        month: 12,
        balance: "10500.00",
        priorBalance: "10000.00",
        glMovements: [
          {
            date: "2025-12-05",
            description: "PAYE payment (week 1-2)",
            source: "BANKSPEND",
            debit: "5000.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-1205",
          },
          {
            date: "2025-12-19",
            description: "PAYE payment (week 3-4)",
            source: "BANKSPEND",
            debit: "5000.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-1219",
          },
          {
            date: "2025-12-31",
            description: "December PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "10500.00",
            reference: "JNL-112",
          },
        ],
        closingItems: [
          { description: "December PAYE accrual", amount: "10500.00" },
        ],
      },
      // ── January: BF 10500, three payments of 3500 each, new accrual 10500 ──
      {
        year: 2026,
        month: 1,
        balance: "10500.00",
        priorBalance: "10500.00",
        glMovements: [
          {
            date: "2026-01-07",
            description: "PAYE payment (week 1)",
            source: "BANKSPEND",
            debit: "3500.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-0107",
          },
          {
            date: "2026-01-14",
            description: "PAYE payment (week 2)",
            source: "BANKSPEND",
            debit: "3500.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-0114",
          },
          {
            date: "2026-01-21",
            description: "PAYE payment (week 3)",
            source: "BANKSPEND",
            debit: "3500.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-0121",
          },
          {
            date: "2026-01-31",
            description: "January PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "10500.00",
            reference: "JNL-113",
          },
        ],
        closingItems: [
          { description: "January PAYE accrual", amount: "10500.00" },
        ],
      },
      // ── February: BF 10500, two payments 7000 + 3500.50 (£0.50 over), new accrual 10800 ──
      {
        year: 2026,
        month: 2,
        balance: "10800.00",
        priorBalance: "10500.00",
        glMovements: [
          {
            date: "2026-02-10",
            description: "PAYE payment (main)",
            source: "BANKSPEND",
            debit: "7000.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-0210",
          },
          {
            date: "2026-02-20",
            description: "PAYE payment (balance)",
            source: "BANKSPEND",
            debit: "3500.50",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-0220",
          },
          {
            date: "2026-02-28",
            description: "February PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "10800.00",
            reference: "JNL-114",
          },
        ],
        // Feb closing items left EMPTY — user needs to reconcile
        closingItems: [],
      },
    ],
  });

  // ════════════════════════════════════════════════════════════════
  // COMPANY C: Charlie Holdings Ltd — Partial payment / residual
  // ════════════════════════════════════════════════════════════════
  console.log(
    "\n── Company C: Charlie Holdings Ltd (partial payment / residual) ──"
  );
  await createCompany({
    name: "Charlie Holdings Ltd",
    code: "CHARLIE",
    xeroAccountId: `${PAYE_XERO_ID_PREFIX}charlie`,
    months: [
      // ── November (prior) ──
      {
        year: 2025,
        month: 11,
        balance: "8000.00",
        priorBalance: null,
        glMovements: [
          {
            date: "2025-11-30",
            description: "November PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "8000.00",
          },
        ],
        closingItems: [
          { description: "November PAYE accrual", amount: "8000.00" },
        ],
      },
      // ── December: BF 8000, only 6000 paid (2000 residual), new accrual 8500 ──
      // Closing = 8500 (new accrual) + 2000 (unpaid BF) = 10500
      {
        year: 2025,
        month: 12,
        balance: "10500.00",
        priorBalance: "8000.00",
        glMovements: [
          {
            date: "2025-12-15",
            description: "PAYE part-payment to HMRC",
            source: "BANKSPEND",
            debit: "6000.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-C1215",
          },
          {
            date: "2025-12-31",
            description: "December PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "8500.00",
            reference: "JNL-C12",
          },
        ],
        closingItems: [
          { description: "December PAYE accrual", amount: "8500.00" },
          { description: "Unpaid BF residual", amount: "2000.00" },
        ],
      },
      // ── January: BF 10500 (8500 + 2000), payments 8500 + 2000, new accrual 8500 ──
      {
        year: 2026,
        month: 1,
        balance: "8500.00",
        priorBalance: "10500.00",
        glMovements: [
          {
            date: "2026-01-15",
            description: "PAYE payment (Dec accrual)",
            source: "BANKSPEND",
            debit: "8500.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-C0115",
          },
          {
            date: "2026-01-16",
            description: "PAYE payment (Nov arrears)",
            source: "BANKSPEND",
            debit: "2000.00",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-C0116",
          },
          {
            date: "2026-01-31",
            description: "January PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "8500.00",
            reference: "JNL-C01",
          },
        ],
        closingItems: [
          { description: "January PAYE accrual", amount: "8500.00" },
        ],
      },
      // ── February: BF 8500, payment of 8499.37 (rounding diff 0.63), new accrual 9000 ──
      // BS balance = 9000.63 (accrual 9000 + rounding 0.63)
      {
        year: 2026,
        month: 2,
        balance: "9000.63",
        priorBalance: "8500.00",
        glMovements: [
          {
            date: "2026-02-14",
            description: "PAYE payment to HMRC",
            source: "BANKSPEND",
            debit: "8499.37",
            credit: "0",
            contact: "HMRC",
            reference: "BACS-C0214",
          },
          {
            date: "2026-02-28",
            description: "February PAYE accrual",
            source: "MANJOURNAL",
            debit: "0",
            credit: "9000.00",
            reference: "JNL-C02",
          },
        ],
        // Feb closing items left EMPTY — user needs to reconcile
        closingItems: [],
      },
    ],
  });

  console.log("\n✓ Test data seeded successfully.");
  console.log("  3 companies × ~4 periods each = 12 periods");
  console.log("  Focus accounts: PAYE Payable (820) using pensions_payable module");
  console.log("\n  Scenarios:");
  console.log("    Alpha  — single exact payment clears BF each month");
  console.log("    Bravo  — multiple payments clear BF (2 or 3 payments)");
  console.log("    Charlie — partial payment, residual carry-forward, rounding");
  console.log("\n  February is left un-reconciled for each company (no closing items).");

  await client.end();
}

seedTestData().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
