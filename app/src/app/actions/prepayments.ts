"use server";

import { db } from "@/lib/db";
import {
  prepayments,
  prepaymentScheduleLines,
  reconciliationAccounts,
  reconciliationPeriods,
  xeroConnections,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq, and, asc, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { xeroGet } from "@/lib/xero/client";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Get the last day of a month as a date string (YYYY-MM-DD) */
function monthEndDate(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** Calculate the number of months between two dates (inclusive, month-based). */
function calculateMonths(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const months =
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth()) +
    1; // inclusive
  return Math.max(months, 1);
}

type SpreadMethod = "equal" | "daily_proration" | "half_month";

type ScheduleLineInput = {
  prepaymentId: string;
  monthEndDate: string;
  openingBalance: string;
  monthlyExpense: string;
  closingBalance: string;
  originalAmount: string;
};

/** Count days in a given month (1-based). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Generate schedule lines for a prepayment using the specified spread method.
 *
 * - "equal": straight-line, same amount every month, last month true-up
 * - "daily_proration": pro-rata by actual days covered in each month
 * - "half_month": partial months get half allocation, full months get full
 */
function generateScheduleLines(
  prepaymentId: string,
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number,
  spreadMethod: SpreadMethod
): ScheduleLineInput[] {
  switch (spreadMethod) {
    case "daily_proration":
      return generateDailyProration(prepaymentId, startDate, endDate, totalAmount, numberOfMonths);
    case "half_month":
      return generateHalfMonth(prepaymentId, startDate, endDate, totalAmount, numberOfMonths);
    case "equal":
    default:
      return generateEqual(prepaymentId, startDate, totalAmount, numberOfMonths);
  }
}

/** Equal spread: same amount every month with last month true-up. */
function generateEqual(
  prepaymentId: string,
  startDate: string,
  totalAmount: number,
  numberOfMonths: number
): ScheduleLineInput[] {
  const monthlyAmount = Math.round((totalAmount / numberOfMonths) * 100) / 100;
  const lines: ScheduleLineInput[] = [];

  const start = new Date(startDate);
  let currentYear = start.getFullYear();
  let currentMonth = start.getMonth() + 1;
  let openingBalance = totalAmount;

  for (let i = 0; i < numberOfMonths; i++) {
    const isLastMonth = i === numberOfMonths - 1;
    const expense = isLastMonth
      ? Math.round(openingBalance * 100) / 100
      : monthlyAmount;
    const closingBal = Math.round((openingBalance - expense) * 100) / 100;

    lines.push({
      prepaymentId,
      monthEndDate: monthEndDate(currentYear, currentMonth),
      openingBalance: openingBalance.toFixed(2),
      monthlyExpense: expense.toFixed(2),
      closingBalance: closingBal.toFixed(2),
      originalAmount: expense.toFixed(2),
    });

    openingBalance = closingBal;
    currentMonth++;
    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear++;
    }
  }

  return lines;
}

/**
 * Daily proration: allocate based on actual days covered in each month.
 * e.g. start 9 Jan, end 8 Apr → Jan has 23 days, Feb 28, Mar 31, Apr 8 = 90 total.
 */
function generateDailyProration(
  prepaymentId: string,
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number
): ScheduleLineInput[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const lines: ScheduleLineInput[] = [];

  // Calculate days per month
  const monthDays: { year: number; month: number; days: number }[] = [];
  let curYear = start.getFullYear();
  let curMonth = start.getMonth() + 1;

  for (let i = 0; i < numberOfMonths; i++) {
    const totalDaysInMonth = daysInMonth(curYear, curMonth);
    let days: number;

    if (i === 0 && i === numberOfMonths - 1) {
      // Single month: start day to end day
      days = end.getDate() - start.getDate() + 1;
    } else if (i === 0) {
      // First month: from start date to end of month
      days = totalDaysInMonth - start.getDate() + 1;
    } else if (i === numberOfMonths - 1) {
      // Last month: from 1st to end date
      days = end.getDate();
    } else {
      // Full month
      days = totalDaysInMonth;
    }

    monthDays.push({ year: curYear, month: curMonth, days: Math.max(days, 0) });
    curMonth++;
    if (curMonth > 12) {
      curMonth = 1;
      curYear++;
    }
  }

  const totalDays = monthDays.reduce((sum, m) => sum + m.days, 0);
  let openingBalance = totalAmount;

  for (let i = 0; i < monthDays.length; i++) {
    const m = monthDays[i];
    const isLast = i === monthDays.length - 1;
    // Last month gets remainder to avoid rounding drift
    const expense = isLast
      ? Math.round(openingBalance * 100) / 100
      : Math.round((totalAmount * m.days / totalDays) * 100) / 100;
    const closingBal = Math.round((openingBalance - expense) * 100) / 100;

    lines.push({
      prepaymentId,
      monthEndDate: monthEndDate(m.year, m.month),
      openingBalance: openingBalance.toFixed(2),
      monthlyExpense: expense.toFixed(2),
      closingBalance: closingBal.toFixed(2),
      originalAmount: expense.toFixed(2),
    });

    openingBalance = closingBal;
  }

  return lines;
}

/**
 * Half-month convention: partial months get half a monthly allocation,
 * full months get a full monthly allocation.
 *
 * A month is "partial" if the start date is not the 1st (first month)
 * or the end date is not the last day of the month (last month).
 */
function generateHalfMonth(
  prepaymentId: string,
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number
): ScheduleLineInput[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const lines: ScheduleLineInput[] = [];

  // Determine which months are partial
  const firstMonthPartial = start.getDate() > 1;
  const lastDayOfEndMonth = daysInMonth(end.getFullYear(), end.getMonth() + 1);
  const lastMonthPartial = numberOfMonths > 1 && end.getDate() < lastDayOfEndMonth;

  // Calculate effective month units (partial = 0.5, full = 1)
  let effectiveMonths = 0;
  for (let i = 0; i < numberOfMonths; i++) {
    if (i === 0 && firstMonthPartial) {
      effectiveMonths += 0.5;
    } else if (i === numberOfMonths - 1 && lastMonthPartial) {
      effectiveMonths += 0.5;
    } else {
      effectiveMonths += 1;
    }
  }

  const perUnit = totalAmount / effectiveMonths;
  let curYear = start.getFullYear();
  let curMonth = start.getMonth() + 1;
  let openingBalance = totalAmount;

  for (let i = 0; i < numberOfMonths; i++) {
    const isLast = i === numberOfMonths - 1;
    let weight: number;
    if (i === 0 && firstMonthPartial) {
      weight = 0.5;
    } else if (isLast && lastMonthPartial) {
      weight = 0.5;
    } else {
      weight = 1;
    }

    const expense = isLast
      ? Math.round(openingBalance * 100) / 100
      : Math.round((perUnit * weight) * 100) / 100;
    const closingBal = Math.round((openingBalance - expense) * 100) / 100;

    lines.push({
      prepaymentId,
      monthEndDate: monthEndDate(curYear, curMonth),
      openingBalance: openingBalance.toFixed(2),
      monthlyExpense: expense.toFixed(2),
      closingBalance: closingBal.toFixed(2),
      originalAmount: expense.toFixed(2),
    });

    openingBalance = closingBal;
    curMonth++;
    if (curMonth > 12) {
      curMonth = 1;
      curYear++;
    }
  }

  return lines;
}

// ------------------------------------------------------------------
// Search Xero for ACCPAY (bill) invoices to link to a prepayment
// ------------------------------------------------------------------

interface XeroBillResult {
  invoiceId: string;
  invoiceNumber: string;
  contactName: string;
  date: string;
  total: number;
  reference: string | null;
  url: string;
}

interface XeroBill {
  InvoiceID: string;
  InvoiceNumber: string;
  Contact: { Name: string };
  Date: string;
  Total: number;
  Reference?: string;
  Status: string;
}

/** Parse Xero's /Date(...)/ format or ISO date string to YYYY-MM-DD */
function parseXeroDate(dateStr: string): string {
  const msMatch = dateStr.match(/\/Date\((\d+)([+-]\d{4})?\)\//);
  if (msMatch) {
    return new Date(Number(msMatch[1])).toISOString().split("T")[0];
  }
  return dateStr.split("T")[0];
}

export async function searchXeroInvoices(
  clientId: string,
  searchTerm: string
): Promise<{ invoices: XeroBillResult[] } | { error: string }> {
  await requireRole("junior");

  if (!searchTerm || searchTerm.trim().length < 2) {
    return { error: "Search term must be at least 2 characters" };
  }

  // Find the Xero connection for this client
  const [connection] = await db
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.clientId, clientId))
    .limit(1);

  if (!connection || connection.status !== "active") {
    return { error: "No active Xero connection for this client" };
  }

  try {
    // Search ACCPAY invoices (bills) by contact name or invoice number
    const term = searchTerm.trim().replace(/"/g, "");
    const whereFilter = `Type=="ACCPAY" AND (Contact.Name.Contains("${term}") || InvoiceNumber.Contains("${term}"))`;
    const encoded = encodeURIComponent(whereFilter);

    const resp = await xeroGet<{ Invoices: XeroBill[] }>(
      connection.id,
      connection.xeroTenantId,
      `/Invoices?where=${encoded}&order=Date%20DESC&page=1`
    );

    const invoices: XeroBillResult[] = (resp.Invoices || [])
      .filter((inv) => inv.Status !== "VOIDED" && inv.Status !== "DELETED")
      .slice(0, 20)
      .map((inv) => ({
        invoiceId: inv.InvoiceID,
        invoiceNumber: inv.InvoiceNumber,
        contactName: inv.Contact.Name,
        date: parseXeroDate(inv.Date),
        total: inv.Total,
        reference: inv.Reference || null,
        url: `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${inv.InvoiceID}`,
      }));

    return { invoices };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to search Xero invoices" };
  }
}

// ------------------------------------------------------------------
// Create a prepayment and generate its schedule
// ------------------------------------------------------------------
export async function createPrepayment(formData: FormData) {
  const session = await requireRole("junior");

  const clientId = formData.get("clientId") as string;
  const vendorName = formData.get("vendorName") as string;
  const description = formData.get("description") as string;
  const nominalAccount = formData.get("nominalAccount") as string;
  const startDate = formData.get("startDate") as string;
  const endDate = formData.get("endDate") as string;
  const totalAmountStr = formData.get("totalAmount") as string;
  const periodId = formData.get("periodId") as string;
  const spreadMethod = (formData.get("spreadMethod") as SpreadMethod) || "equal";
  const xeroInvoiceId = (formData.get("xeroInvoiceId") as string) || null;
  const xeroInvoiceUrl = (formData.get("xeroInvoiceUrl") as string) || null;

  if (!clientId || !vendorName || !description || !nominalAccount || !startDate || !endDate || !totalAmountStr) {
    return { error: "Missing required fields" };
  }

  const totalAmount = parseFloat(totalAmountStr);
  if (isNaN(totalAmount) || totalAmount <= 0) {
    return { error: "Total amount must be a positive number" };
  }

  if (new Date(endDate) <= new Date(startDate)) {
    return { error: "End date must be after start date" };
  }

  const numberOfMonths = calculateMonths(startDate, endDate);
  const monthlyAmount =
    Math.round((totalAmount / numberOfMonths) * 100) / 100;

  // Insert prepayment (fall back without xero columns if migration 0010 not yet applied)
  let prepayment;
  try {
    [prepayment] = await db
      .insert(prepayments)
      .values({
        clientId,
        vendorName,
        description,
        nominalAccount,
        startDate,
        endDate,
        totalAmount: totalAmount.toFixed(2),
        numberOfMonths,
        monthlyAmount: monthlyAmount.toFixed(2),
        spreadMethod,
        xeroInvoiceId,
        xeroInvoiceUrl,
        createdBy: session.user.id,
      })
      .returning();
  } catch {
    [prepayment] = await db
      .insert(prepayments)
      .values({
        clientId,
        vendorName,
        description,
        nominalAccount,
        startDate,
        endDate,
        totalAmount: totalAmount.toFixed(2),
        numberOfMonths,
        monthlyAmount: monthlyAmount.toFixed(2),
        spreadMethod,
        createdBy: session.user.id,
      } as typeof prepayments.$inferInsert)
      .returning();
  }

  // Generate and insert schedule lines
  const lines = generateScheduleLines(
    prepayment.id,
    startDate,
    endDate,
    totalAmount,
    numberOfMonths,
    spreadMethod
  );

  if (lines.length > 0) {
    await db.insert(prepaymentScheduleLines).values(lines);
  }

  // Revalidate the current page
  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, periodId))
    .limit(1);

  if (period) {
    revalidatePath(
      `/clients/${clientId}/periods/${periodId}`
    );
  }

  return { success: true, prepaymentId: prepayment.id };
}

// ------------------------------------------------------------------
// Load all prepayment data for a client, scoped to a period view
// ------------------------------------------------------------------
export async function loadPrepaymentsData(
  accountId: string,
  clientId: string,
  periodYear: number,
  periodMonth: number
) {
  await requireRole("junior");

  // Load all active/fully_amortised prepayments for this client
  // Try full select first; fall back if migration 0010 (xero_invoice columns) not yet applied
  let allPrepayments;
  try {
    allPrepayments = await db
      .select()
      .from(prepayments)
      .where(eq(prepayments.clientId, clientId))
      .orderBy(asc(prepayments.startDate));
  } catch {
    allPrepayments = await db
      .select({
        id: prepayments.id,
        clientId: prepayments.clientId,
        vendorName: prepayments.vendorName,
        description: prepayments.description,
        nominalAccount: prepayments.nominalAccount,
        startDate: prepayments.startDate,
        endDate: prepayments.endDate,
        totalAmount: prepayments.totalAmount,
        currency: prepayments.currency,
        numberOfMonths: prepayments.numberOfMonths,
        monthlyAmount: prepayments.monthlyAmount,
        spreadMethod: prepayments.spreadMethod,
        status: prepayments.status,
        createdBy: prepayments.createdBy,
        createdAt: prepayments.createdAt,
        updatedAt: prepayments.updatedAt,
      })
      .from(prepayments)
      .where(eq(prepayments.clientId, clientId))
      .orderBy(asc(prepayments.startDate));
  }

  if (allPrepayments.length === 0) {
    return { prepayments: [], scheduleLines: [], monthColumns: [], ledgerBalances: {} };
  }

  const prepaymentIds = allPrepayments.map((p) => p.id);

  // Load all schedule lines for these prepayments
  const allLines = await db
    .select()
    .from(prepaymentScheduleLines)
    .where(inArray(prepaymentScheduleLines.prepaymentId, prepaymentIds))
    .orderBy(asc(prepaymentScheduleLines.monthEndDate));

  // Determine month columns: start from the viewing period, extend forward
  // to cover all active prepayment schedule lines
  const viewingMonthEnd = monthEndDate(periodYear, periodMonth);

  // Collect all unique month_end_dates from schedule lines that are >= viewing period
  const monthSet = new Set<string>();
  for (const line of allLines) {
    if (line.monthEndDate >= viewingMonthEnd) {
      monthSet.add(line.monthEndDate);
    }
  }
  // Always include the viewing month
  monthSet.add(viewingMonthEnd);

  const monthColumns = Array.from(monthSet).sort();

  // Load ledger balances from reconciliation_accounts for past/current months
  // These are the Xero balances for the same account across periods
  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  const ledgerBalances: Record<string, number> = {};

  if (account) {
    // Load all periods for this client
    const periods = await db
      .select()
      .from(reconciliationPeriods)
      .where(eq(reconciliationPeriods.clientId, clientId))
      .orderBy(
        asc(reconciliationPeriods.periodYear),
        asc(reconciliationPeriods.periodMonth)
      );

    for (const p of periods) {
      const pMonthEnd = monthEndDate(p.periodYear, p.periodMonth);
      if (!monthColumns.includes(pMonthEnd)) continue;

      // Only include ledger balances for current and past months
      if (pMonthEnd > viewingMonthEnd) continue;

      const [periodAccount] = await db
        .select()
        .from(reconciliationAccounts)
        .where(
          and(
            eq(reconciliationAccounts.periodId, p.id),
            eq(reconciliationAccounts.xeroAccountId, account.xeroAccountId)
          )
        )
        .limit(1);

      if (periodAccount) {
        ledgerBalances[pMonthEnd] = parseFloat(periodAccount.balance);
      }
    }
  }

  return {
    prepayments: allPrepayments,
    scheduleLines: allLines,
    monthColumns,
    ledgerBalances,
  };
}

// ------------------------------------------------------------------
// Override a schedule line's monthly expense
// ------------------------------------------------------------------
export async function overridePrepaymentLine(
  lineId: string,
  overrideAmount: number,
  auditNotes: string | null,
  periodId: string,
  clientId: string
) {
  await requireRole("junior");

  // Load the line being overridden
  const [line] = await db
    .select()
    .from(prepaymentScheduleLines)
    .where(eq(prepaymentScheduleLines.id, lineId))
    .limit(1);

  if (!line) return { error: "Schedule line not found" };

  // Load the prepayment
  const [prepayment] = await db
    .select()
    .from(prepayments)
    .where(eq(prepayments.id, line.prepaymentId))
    .limit(1);

  if (!prepayment) return { error: "Prepayment not found" };

  // Load all schedule lines for this prepayment in order
  const allLines = await db
    .select()
    .from(prepaymentScheduleLines)
    .where(eq(prepaymentScheduleLines.prepaymentId, prepayment.id))
    .orderBy(asc(prepaymentScheduleLines.monthEndDate));

  const lineIndex = allLines.findIndex((l) => l.id === lineId);
  if (lineIndex === -1) return { error: "Line not found in schedule" };

  // Apply override and recalculate subsequent lines
  const totalAmount = parseFloat(prepayment.totalAmount);

  // Calculate total already expensed in previous months (before this line)
  let totalExpensedBefore = 0;
  for (let i = 0; i < lineIndex; i++) {
    totalExpensedBefore += parseFloat(allLines[i].monthlyExpense);
  }

  // Set the override on this line
  const openingBalance = parseFloat(allLines[lineIndex].openingBalance);
  const newClosing = Math.round((openingBalance - overrideAmount) * 100) / 100;
  const totalExpensedAfterThis = totalExpensedBefore + overrideAmount;

  // Update the overridden line
  await db
    .update(prepaymentScheduleLines)
    .set({
      monthlyExpense: overrideAmount.toFixed(2),
      closingBalance: newClosing.toFixed(2),
      overrideAmount: overrideAmount.toFixed(2),
      isOverridden: true,
      auditNotes,
      updatedAt: new Date(),
    })
    .where(eq(prepaymentScheduleLines.id, lineId));

  // Recalculate subsequent lines
  const remainingMonths = allLines.length - lineIndex - 1;
  const remainingAmount = totalAmount - totalExpensedAfterThis;

  if (remainingMonths > 0) {
    const newMonthlyAmount =
      Math.round((remainingAmount / remainingMonths) * 100) / 100;
    let currentOpening = newClosing;

    for (let i = lineIndex + 1; i < allLines.length; i++) {
      const isLast = i === allLines.length - 1;
      const expense = isLast
        ? Math.round(currentOpening * 100) / 100
        : newMonthlyAmount;
      const closing = Math.round((currentOpening - expense) * 100) / 100;

      await db
        .update(prepaymentScheduleLines)
        .set({
          openingBalance: currentOpening.toFixed(2),
          monthlyExpense: expense.toFixed(2),
          closingBalance: closing.toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(prepaymentScheduleLines.id, allLines[i].id));

      currentOpening = closing;
    }
  }

  revalidatePath(`/clients/${clientId}/periods/${periodId}`);
  return { success: true };
}

// ------------------------------------------------------------------
// Cancel a prepayment
// ------------------------------------------------------------------
export async function cancelPrepayment(
  prepaymentId: string,
  periodId: string,
  clientId: string
) {
  await requireRole("junior");

  const [prepayment] = await db
    .select()
    .from(prepayments)
    .where(eq(prepayments.id, prepaymentId))
    .limit(1);

  if (!prepayment) return { error: "Prepayment not found" };

  await db
    .update(prepayments)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(prepayments.id, prepaymentId));

  revalidatePath(`/clients/${clientId}/periods/${periodId}`);
  return { success: true };
}

// ------------------------------------------------------------------
// Delete a prepayment entirely
// ------------------------------------------------------------------
export async function deletePrepayment(
  prepaymentId: string,
  periodId: string,
  clientId: string
) {
  await requireRole("manager");

  // Schedule lines are cascade-deleted
  await db.delete(prepayments).where(eq(prepayments.id, prepaymentId));

  revalidatePath(`/clients/${clientId}/periods/${periodId}`);
  return { success: true };
}
