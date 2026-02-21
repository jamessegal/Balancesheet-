"use server";

import { db } from "@/lib/db";
import {
  reconciliationPeriods,
  reconciliationAccounts,
  xeroConnections,
  clients,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { xeroGet } from "@/lib/xero/client";
import { eq, and, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// ------------------------------------------------------------------
// Create a new reconciliation period
// ------------------------------------------------------------------
export async function createPeriod(formData: FormData) {
  const session = await requireRole("manager");

  const clientId = formData.get("clientId") as string;
  const year = parseInt(formData.get("year") as string, 10);
  const month = parseInt(formData.get("month") as string, 10);

  if (!clientId || !year || !month || month < 1 || month > 12) {
    return { error: "Invalid period data" };
  }

  // Check client exists
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (!client) {
    return { error: "Client not found" };
  }

  // Check for duplicate period
  const [existing] = await db
    .select()
    .from(reconciliationPeriods)
    .where(
      and(
        eq(reconciliationPeriods.clientId, clientId),
        eq(reconciliationPeriods.periodYear, year),
        eq(reconciliationPeriods.periodMonth, month)
      )
    )
    .limit(1);

  if (existing) {
    return { error: "A period already exists for this month" };
  }

  const [period] = await db
    .insert(reconciliationPeriods)
    .values({
      clientId,
      periodYear: year,
      periodMonth: month,
      openedBy: session.user.id,
    })
    .returning();

  revalidatePath(`/clients/${clientId}`);
  redirect(`/clients/${clientId}/periods/${period.id}`);
}

// ------------------------------------------------------------------
// Get all periods for a client
// ------------------------------------------------------------------
export async function getPeriodsForClient(clientId: string) {
  await requireRole("junior");

  return db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.clientId, clientId))
    .orderBy(
      desc(reconciliationPeriods.periodYear),
      desc(reconciliationPeriods.periodMonth)
    );
}

// ------------------------------------------------------------------
// Get a single period with its accounts
// ------------------------------------------------------------------
export async function getPeriodWithAccounts(periodId: string) {
  await requireRole("junior");

  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, periodId))
    .limit(1);

  if (!period) {
    return null;
  }

  const accounts = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.periodId, periodId))
    .orderBy(reconciliationAccounts.accountCode);

  return { period, accounts };
}

// ------------------------------------------------------------------
// Pull balance sheet from Xero and populate accounts
// ------------------------------------------------------------------

interface XeroBalanceSheetReport {
  Reports: {
    ReportID: string;
    ReportName: string;
    ReportDate: string;
    Rows: XeroReportRow[];
  }[];
}

interface XeroReportRow {
  RowType: "Header" | "Section" | "Row" | "SummaryRow";
  Title?: string;
  Rows?: XeroReportRow[];
  Cells?: { Value: string; Attributes?: { Value: string; Id: string }[] }[];
}

export async function pullBalanceSheet(periodId: string) {
  const session = await requireRole("manager");

  // Get the period
  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, periodId))
    .limit(1);

  if (!period) {
    return { error: "Period not found" };
  }

  // Get the Xero connection for this client
  const [connection] = await db
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.clientId, period.clientId))
    .limit(1);

  if (!connection || connection.status !== "active") {
    return { error: "No active Xero connection for this client" };
  }

  // Build the date for the end of the period month
  const lastDay = new Date(period.periodYear, period.periodMonth, 0).getDate();
  const periodDate = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // Also get prior month date for prior balances
  const priorMonth = period.periodMonth === 1 ? 12 : period.periodMonth - 1;
  const priorYear =
    period.periodMonth === 1 ? period.periodYear - 1 : period.periodYear;
  const priorLastDay = new Date(priorYear, priorMonth, 0).getDate();
  const priorDate = `${priorYear}-${String(priorMonth).padStart(2, "0")}-${String(priorLastDay).padStart(2, "0")}`;

  try {
    // Fetch current and prior balance sheets in parallel
    const [currentBS, priorBS] = await Promise.all([
      xeroGet<XeroBalanceSheetReport>(
        connection.id,
        connection.xeroTenantId,
        `/Reports/BalanceSheet?date=${periodDate}`
      ),
      xeroGet<XeroBalanceSheetReport>(
        connection.id,
        connection.xeroTenantId,
        `/Reports/BalanceSheet?date=${priorDate}`
      ),
    ]);

    // Parse accounts from the Xero balance sheet report
    const currentAccounts = parseBalanceSheetAccounts(currentBS);
    const priorAccounts = parseBalanceSheetAccounts(priorBS);

    // Build a map of prior balances keyed by account ID
    const priorBalanceMap = new Map<string, string>();
    for (const acc of priorAccounts) {
      priorBalanceMap.set(acc.accountId, acc.balance);
    }

    // Upsert reconciliation accounts
    for (const acc of currentAccounts) {
      const [existing] = await db
        .select()
        .from(reconciliationAccounts)
        .where(
          and(
            eq(reconciliationAccounts.periodId, periodId),
            eq(reconciliationAccounts.xeroAccountId, acc.accountId)
          )
        )
        .limit(1);

      const priorBalance = priorBalanceMap.get(acc.accountId) ?? null;

      if (existing) {
        await db
          .update(reconciliationAccounts)
          .set({
            balance: acc.balance,
            priorBalance: priorBalance,
            accountName: acc.name,
            accountCode: acc.code,
            accountType: acc.type,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(reconciliationAccounts.id, existing.id));
      } else {
        await db.insert(reconciliationAccounts).values({
          periodId,
          xeroAccountId: acc.accountId,
          accountCode: acc.code,
          accountName: acc.name,
          accountType: acc.type,
          balance: acc.balance,
          priorBalance: priorBalance,
          lastSyncedAt: new Date(),
        });
      }
    }

    // Update period status to in_progress if still draft
    if (period.status === "draft") {
      await db
        .update(reconciliationPeriods)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(eq(reconciliationPeriods.id, periodId));
    }

    // Update last synced
    await db
      .update(xeroConnections)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(xeroConnections.id, connection.id));

    revalidatePath(`/clients/${period.clientId}/periods/${periodId}`);

    return { success: true, accountCount: currentAccounts.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: `Failed to pull balance sheet: ${message}` };
  }
}

// ------------------------------------------------------------------
// Parse the Xero balance sheet report into flat account list
// ------------------------------------------------------------------

interface ParsedAccount {
  accountId: string;
  code: string;
  name: string;
  type: string;
  balance: string;
}

function parseBalanceSheetAccounts(
  report: XeroBalanceSheetReport
): ParsedAccount[] {
  const accounts: ParsedAccount[] = [];

  if (!report.Reports || report.Reports.length === 0) {
    return accounts;
  }

  const rows = report.Reports[0].Rows;
  if (!rows) return accounts;

  function extractFromRows(rows: XeroReportRow[], sectionTitle: string) {
    for (const row of rows) {
      if (row.RowType === "Section" && row.Rows) {
        const title = row.Title || sectionTitle;
        extractFromRows(row.Rows, title);
      } else if (row.RowType === "Row" && row.Cells) {
        const cells = row.Cells;
        if (cells.length >= 2) {
          const accountIdAttr = cells[0].Attributes?.find(
            (a) => a.Id === "account"
          );
          if (accountIdAttr) {
            accounts.push({
              accountId: accountIdAttr.Value,
              code: "",
              name: cells[0].Value,
              type: sectionTitle,
              balance: cells[1].Value || "0",
            });
          }
        }
      }
    }
  }

  extractFromRows(rows, "");

  return accounts;
}
