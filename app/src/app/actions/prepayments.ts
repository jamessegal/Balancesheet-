"use server";

import { db } from "@/lib/db";
import {
  prepayments,
  prepaymentScheduleLines,
  reconciliationAccounts,
  reconciliationPeriods,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq, and, asc, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

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

/**
 * Generate schedule lines for a prepayment.
 * Straight-line allocation with final month true-up.
 */
function generateScheduleLines(
  prepaymentId: string,
  startDate: string,
  totalAmount: number,
  numberOfMonths: number
): {
  prepaymentId: string;
  monthEndDate: string;
  openingBalance: string;
  monthlyExpense: string;
  closingBalance: string;
  originalAmount: string;
}[] {
  const monthlyAmount = Math.round((totalAmount / numberOfMonths) * 100) / 100;
  const lines: {
    prepaymentId: string;
    monthEndDate: string;
    openingBalance: string;
    monthlyExpense: string;
    closingBalance: string;
    originalAmount: string;
  }[] = [];

  const start = new Date(startDate);
  let currentYear = start.getFullYear();
  let currentMonth = start.getMonth() + 1; // 1-based
  let openingBalance = totalAmount;

  for (let i = 0; i < numberOfMonths; i++) {
    const isLastMonth = i === numberOfMonths - 1;
    // Final month true-up: ensure total amortisation equals original amount exactly
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

    // Advance to next month
    currentMonth++;
    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear++;
    }
  }

  return lines;
}

// ------------------------------------------------------------------
// Create a prepayment and generate its schedule
// ------------------------------------------------------------------
export async function createPrepayment(formData: FormData) {
  const session = await requireRole("junior");

  const clientId = formData.get("clientId") as string;
  const vendorName = formData.get("vendorName") as string;
  const description = (formData.get("description") as string) || null;
  const nominalAccount = (formData.get("nominalAccount") as string) || null;
  const startDate = formData.get("startDate") as string;
  const endDate = formData.get("endDate") as string;
  const totalAmountStr = formData.get("totalAmount") as string;
  const periodId = formData.get("periodId") as string;

  if (!clientId || !vendorName || !startDate || !endDate || !totalAmountStr) {
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

  // Insert prepayment
  const [prepayment] = await db
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
      createdBy: session.user.id,
    })
    .returning();

  // Generate and insert schedule lines
  const lines = generateScheduleLines(
    prepayment.id,
    startDate,
    totalAmount,
    numberOfMonths
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
  const allPrepayments = await db
    .select()
    .from(prepayments)
    .where(eq(prepayments.clientId, clientId))
    .orderBy(asc(prepayments.startDate));

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
