"use server";

import { db } from "@/lib/db";
import {
  deferredIncomeItems,
  deferredIncomeScheduleLines,
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

type SpreadMethod = "equal" | "daily_proration" | "half_month";

type ScheduleLineInput = {
  deferredIncomeId: string;
  monthEndDate: string;
  openingBalance: string;
  monthlyRecognition: string;
  closingBalance: string;
  originalAmount: string;
};

/** Count days in a given month (1-based). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Generate schedule lines for a deferred income item using the specified spread method.
 *
 * - "equal": straight-line, same amount every month, last month true-up
 * - "daily_proration": pro-rata by actual days covered in each month
 * - "half_month": partial months get half allocation, full months get full
 */
function generateScheduleLines(
  deferredIncomeId: string,
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number,
  spreadMethod: SpreadMethod
): ScheduleLineInput[] {
  switch (spreadMethod) {
    case "daily_proration":
      return generateDailyProration(deferredIncomeId, startDate, endDate, totalAmount, numberOfMonths);
    case "half_month":
      return generateHalfMonth(deferredIncomeId, startDate, endDate, totalAmount, numberOfMonths);
    case "equal":
    default:
      return generateEqual(deferredIncomeId, startDate, totalAmount, numberOfMonths);
  }
}

/** Equal spread: same amount every month with last month true-up. */
function generateEqual(
  deferredIncomeId: string,
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
    const recognition = isLastMonth
      ? Math.round(openingBalance * 100) / 100
      : monthlyAmount;
    const closingBal = Math.round((openingBalance - recognition) * 100) / 100;

    lines.push({
      deferredIncomeId,
      monthEndDate: monthEndDate(currentYear, currentMonth),
      openingBalance: openingBalance.toFixed(2),
      monthlyRecognition: recognition.toFixed(2),
      closingBalance: closingBal.toFixed(2),
      originalAmount: recognition.toFixed(2),
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
 */
function generateDailyProration(
  deferredIncomeId: string,
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number
): ScheduleLineInput[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const lines: ScheduleLineInput[] = [];

  const monthDays: { year: number; month: number; days: number }[] = [];
  let curYear = start.getFullYear();
  let curMonth = start.getMonth() + 1;

  for (let i = 0; i < numberOfMonths; i++) {
    const totalDaysInMonth = daysInMonth(curYear, curMonth);
    let days: number;

    if (i === 0 && i === numberOfMonths - 1) {
      days = end.getDate() - start.getDate() + 1;
    } else if (i === 0) {
      days = totalDaysInMonth - start.getDate() + 1;
    } else if (i === numberOfMonths - 1) {
      days = end.getDate();
    } else {
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
    const recognition = isLast
      ? Math.round(openingBalance * 100) / 100
      : Math.round((totalAmount * m.days / totalDays) * 100) / 100;
    const closingBal = Math.round((openingBalance - recognition) * 100) / 100;

    lines.push({
      deferredIncomeId,
      monthEndDate: monthEndDate(m.year, m.month),
      openingBalance: openingBalance.toFixed(2),
      monthlyRecognition: recognition.toFixed(2),
      closingBalance: closingBal.toFixed(2),
      originalAmount: recognition.toFixed(2),
    });

    openingBalance = closingBal;
  }

  return lines;
}

/**
 * Half-month convention: partial months get half a monthly allocation,
 * full months get a full monthly allocation.
 */
function generateHalfMonth(
  deferredIncomeId: string,
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number
): ScheduleLineInput[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const lines: ScheduleLineInput[] = [];

  const firstMonthPartial = start.getDate() > 1;
  const lastDayOfEndMonth = daysInMonth(end.getFullYear(), end.getMonth() + 1);
  const lastMonthPartial = numberOfMonths > 1 && end.getDate() < lastDayOfEndMonth;

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

    const recognition = isLast
      ? Math.round(openingBalance * 100) / 100
      : Math.round((perUnit * weight) * 100) / 100;
    const closingBal = Math.round((openingBalance - recognition) * 100) / 100;

    lines.push({
      deferredIncomeId,
      monthEndDate: monthEndDate(curYear, curMonth),
      openingBalance: openingBalance.toFixed(2),
      monthlyRecognition: recognition.toFixed(2),
      closingBalance: closingBal.toFixed(2),
      originalAmount: recognition.toFixed(2),
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
// Create a deferred income item and generate its schedule
// ------------------------------------------------------------------
export async function createDeferredIncome(formData: FormData) {
  const session = await requireRole("junior");

  const clientId = formData.get("clientId") as string;
  const customerName = formData.get("customerName") as string;
  const description = formData.get("description") as string;
  const nominalAccount = formData.get("nominalAccount") as string;
  const startDate = formData.get("startDate") as string;
  const endDate = formData.get("endDate") as string;
  const totalAmountStr = formData.get("totalAmount") as string;
  const periodId = formData.get("periodId") as string;
  const spreadMethod = (formData.get("spreadMethod") as SpreadMethod) || "equal";

  if (!clientId || !customerName || !description || !nominalAccount || !startDate || !endDate || !totalAmountStr) {
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

  // Insert deferred income item
  const [item] = await db
    .insert(deferredIncomeItems)
    .values({
      clientId,
      customerName,
      description,
      nominalAccount,
      startDate,
      endDate,
      totalAmount: totalAmount.toFixed(2),
      numberOfMonths,
      monthlyAmount: monthlyAmount.toFixed(2),
      spreadMethod,
      createdBy: session.user.id,
    })
    .returning();

  // Generate and insert schedule lines
  const lines = generateScheduleLines(
    item.id,
    startDate,
    endDate,
    totalAmount,
    numberOfMonths,
    spreadMethod
  );

  if (lines.length > 0) {
    await db.insert(deferredIncomeScheduleLines).values(lines);
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

  return { success: true, deferredIncomeId: item.id };
}

// ------------------------------------------------------------------
// Load all deferred income data for a client, scoped to a period view
// ------------------------------------------------------------------
export async function loadDeferredIncomeData(
  accountId: string,
  clientId: string,
  periodYear: number,
  periodMonth: number
) {
  await requireRole("junior");

  // Load all active/fully_recognised deferred income items for this client
  const allItems = await db
    .select()
    .from(deferredIncomeItems)
    .where(eq(deferredIncomeItems.clientId, clientId))
    .orderBy(asc(deferredIncomeItems.startDate));

  if (allItems.length === 0) {
    return { items: [], scheduleLines: [], monthColumns: [], ledgerBalances: {} };
  }

  const itemIds = allItems.map((i) => i.id);

  // Load all schedule lines for these items
  const allLines = await db
    .select()
    .from(deferredIncomeScheduleLines)
    .where(inArray(deferredIncomeScheduleLines.deferredIncomeId, itemIds))
    .orderBy(asc(deferredIncomeScheduleLines.monthEndDate));

  // Determine month columns: start from the viewing period, extend forward
  const viewingMonthEnd = monthEndDate(periodYear, periodMonth);

  const monthSet = new Set<string>();
  for (const line of allLines) {
    if (line.monthEndDate >= viewingMonthEnd) {
      monthSet.add(line.monthEndDate);
    }
  }
  monthSet.add(viewingMonthEnd);

  const monthColumns = Array.from(monthSet).sort();

  // Load ledger balances from reconciliation_accounts for past/current months
  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  const ledgerBalances: Record<string, number> = {};

  if (account) {
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
    items: allItems,
    scheduleLines: allLines,
    monthColumns,
    ledgerBalances,
  };
}

// ------------------------------------------------------------------
// Override a schedule line's monthly recognition
// ------------------------------------------------------------------
export async function overrideDeferredIncomeLine(
  lineId: string,
  overrideAmount: number,
  auditNotes: string | null,
  periodId: string,
  clientId: string
) {
  await requireRole("junior");

  const [line] = await db
    .select()
    .from(deferredIncomeScheduleLines)
    .where(eq(deferredIncomeScheduleLines.id, lineId))
    .limit(1);

  if (!line) return { error: "Schedule line not found" };

  const [item] = await db
    .select()
    .from(deferredIncomeItems)
    .where(eq(deferredIncomeItems.id, line.deferredIncomeId))
    .limit(1);

  if (!item) return { error: "Deferred income item not found" };

  // Load all schedule lines for this item in order
  const allLines = await db
    .select()
    .from(deferredIncomeScheduleLines)
    .where(eq(deferredIncomeScheduleLines.deferredIncomeId, item.id))
    .orderBy(asc(deferredIncomeScheduleLines.monthEndDate));

  const lineIndex = allLines.findIndex((l) => l.id === lineId);
  if (lineIndex === -1) return { error: "Line not found in schedule" };

  const totalAmount = parseFloat(item.totalAmount);

  // Calculate total already recognised in previous months
  let totalRecognisedBefore = 0;
  for (let i = 0; i < lineIndex; i++) {
    totalRecognisedBefore += parseFloat(allLines[i].monthlyRecognition);
  }

  // Set the override on this line
  const openingBalance = parseFloat(allLines[lineIndex].openingBalance);
  const newClosing = Math.round((openingBalance - overrideAmount) * 100) / 100;
  const totalRecognisedAfterThis = totalRecognisedBefore + overrideAmount;

  // Update the overridden line
  await db
    .update(deferredIncomeScheduleLines)
    .set({
      monthlyRecognition: overrideAmount.toFixed(2),
      closingBalance: newClosing.toFixed(2),
      overrideAmount: overrideAmount.toFixed(2),
      isOverridden: true,
      auditNotes,
      updatedAt: new Date(),
    })
    .where(eq(deferredIncomeScheduleLines.id, lineId));

  // Recalculate subsequent lines
  const remainingMonths = allLines.length - lineIndex - 1;
  const remainingAmount = totalAmount - totalRecognisedAfterThis;

  if (remainingMonths > 0) {
    const newMonthlyAmount =
      Math.round((remainingAmount / remainingMonths) * 100) / 100;
    let currentOpening = newClosing;

    for (let i = lineIndex + 1; i < allLines.length; i++) {
      const isLast = i === allLines.length - 1;
      const recognition = isLast
        ? Math.round(currentOpening * 100) / 100
        : newMonthlyAmount;
      const closing = Math.round((currentOpening - recognition) * 100) / 100;

      await db
        .update(deferredIncomeScheduleLines)
        .set({
          openingBalance: currentOpening.toFixed(2),
          monthlyRecognition: recognition.toFixed(2),
          closingBalance: closing.toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(deferredIncomeScheduleLines.id, allLines[i].id));

      currentOpening = closing;
    }
  }

  revalidatePath(`/clients/${clientId}/periods/${periodId}`);
  return { success: true };
}

// ------------------------------------------------------------------
// Cancel a deferred income item
// ------------------------------------------------------------------
export async function cancelDeferredIncome(
  deferredIncomeId: string,
  periodId: string,
  clientId: string
) {
  await requireRole("junior");

  const [item] = await db
    .select()
    .from(deferredIncomeItems)
    .where(eq(deferredIncomeItems.id, deferredIncomeId))
    .limit(1);

  if (!item) return { error: "Deferred income item not found" };

  await db
    .update(deferredIncomeItems)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(deferredIncomeItems.id, deferredIncomeId));

  revalidatePath(`/clients/${clientId}/periods/${periodId}`);
  return { success: true };
}

// ------------------------------------------------------------------
// Delete a deferred income item entirely
// ------------------------------------------------------------------
export async function deleteDeferredIncome(
  deferredIncomeId: string,
  periodId: string,
  clientId: string
) {
  await requireRole("manager");

  // Schedule lines are cascade-deleted
  await db.delete(deferredIncomeItems).where(eq(deferredIncomeItems.id, deferredIncomeId));

  revalidatePath(`/clients/${clientId}/periods/${periodId}`);
  return { success: true };
}
