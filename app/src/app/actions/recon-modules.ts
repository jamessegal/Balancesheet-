"use server";

import { db } from "@/lib/db";
import {
  reconciliationAccounts,
  reconciliationPeriods,
  reconciliationItems,
  glTransactions,
  users,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq, and, gte, lte } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// ------------------------------------------------------------------
// Add a reconciliation item linked to a GL transaction
// ------------------------------------------------------------------
export async function addReconItemFromGL(
  accountId: string,
  glTransactionId: string,
  description: string,
  amount: string
) {
  const session = await requireRole("junior");

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) return { error: "Account not found" };

  await db.insert(reconciliationItems).values({
    reconAccountId: accountId,
    description,
    amount,
    glTransactionId,
    createdBy: session.user.id,
  });

  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, account.periodId))
    .limit(1);

  if (period) {
    revalidatePath(
      `/clients/${period.clientId}/periods/${period.id}/accounts/${accountId}`
    );
  }

  return { success: true };
}

// ------------------------------------------------------------------
// Bulk save closing items (replaces all existing items for the account)
// Used by module components to save the final reconciliation state
// ------------------------------------------------------------------
export async function saveClosingItems(
  accountId: string,
  items: { description: string; amount: string; glTransactionId?: string }[]
) {
  const session = await requireRole("junior");

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) return { error: "Account not found" };

  // Delete existing items
  await db
    .delete(reconciliationItems)
    .where(eq(reconciliationItems.reconAccountId, accountId));

  // Insert new items
  if (items.length > 0) {
    await db.insert(reconciliationItems).values(
      items.map((item) => ({
        reconAccountId: accountId,
        description: item.description,
        amount: item.amount,
        glTransactionId: item.glTransactionId || null,
        createdBy: session.user.id,
      }))
    );
  }

  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, account.periodId))
    .limit(1);

  if (period) {
    revalidatePath(
      `/clients/${period.clientId}/periods/${period.id}/accounts/${accountId}`
    );
  }

  return { success: true };
}

// ------------------------------------------------------------------
// Load full pensions payable recon data for a period
// ------------------------------------------------------------------
export async function loadPensionsPayableData(accountId: string) {
  await requireRole("junior");

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) return { error: "Account not found" };

  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, account.periodId))
    .limit(1);

  if (!period) return { error: "Period not found" };

  // 1. Load BF items from prior period
  const priorMonth = period.periodMonth === 1 ? 12 : period.periodMonth - 1;
  const priorYear =
    period.periodMonth === 1 ? period.periodYear - 1 : period.periodYear;

  let bfItems: {
    id: string;
    description: string;
    amount: string;
  }[] = [];

  const [priorPeriod] = await db
    .select()
    .from(reconciliationPeriods)
    .where(
      and(
        eq(reconciliationPeriods.clientId, period.clientId),
        eq(reconciliationPeriods.periodYear, priorYear),
        eq(reconciliationPeriods.periodMonth, priorMonth)
      )
    )
    .limit(1);

  if (priorPeriod) {
    const [priorAccount] = await db
      .select()
      .from(reconciliationAccounts)
      .where(
        and(
          eq(reconciliationAccounts.periodId, priorPeriod.id),
          eq(reconciliationAccounts.xeroAccountId, account.xeroAccountId)
        )
      )
      .limit(1);

    if (priorAccount) {
      bfItems = await db
        .select({
          id: reconciliationItems.id,
          description: reconciliationItems.description,
          amount: reconciliationItems.amount,
        })
        .from(reconciliationItems)
        .where(eq(reconciliationItems.reconAccountId, priorAccount.id))
        .orderBy(reconciliationItems.createdAt);
    }
  }

  // 2. Load GL movements for this period
  const periodStart = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(period.periodYear, period.periodMonth, 0).getDate();
  const periodEnd = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  let movements: {
    id: string;
    transactionDate: string;
    description: string | null;
    reference: string | null;
    contact: string | null;
    source: string | null;
    debit: string | null;
    credit: string | null;
  }[] = [];

  try {
    movements = await db
      .select({
        id: glTransactions.id,
        transactionDate: glTransactions.transactionDate,
        description: glTransactions.description,
        reference: glTransactions.reference,
        contact: glTransactions.contact,
        source: glTransactions.source,
        debit: glTransactions.debit,
        credit: glTransactions.credit,
      })
      .from(glTransactions)
      .where(
        and(
          eq(glTransactions.clientId, period.clientId),
          eq(glTransactions.accountName, account.accountName),
          gte(glTransactions.transactionDate, periodStart),
          lte(glTransactions.transactionDate, periodEnd)
        )
      )
      .orderBy(glTransactions.transactionDate);
  } catch {
    // GL tables may not exist
  }

  // 3. Load current closing items
  let closingItems: {
    id: string;
    description: string;
    amount: string;
    glTransactionId: string | null;
    createdByName: string | null;
  }[] = [];

  try {
    closingItems = await db
      .select({
        id: reconciliationItems.id,
        description: reconciliationItems.description,
        amount: reconciliationItems.amount,
        glTransactionId: reconciliationItems.glTransactionId,
        createdByName: users.name,
      })
      .from(reconciliationItems)
      .leftJoin(users, eq(reconciliationItems.createdBy, users.id))
      .where(eq(reconciliationItems.reconAccountId, accountId))
      .orderBy(reconciliationItems.createdAt);
  } catch {
    // Table may not exist
  }

  // 4. Auto-match detection
  const bfTotal = bfItems.reduce(
    (sum, item) => sum + parseFloat(item.amount || "0"),
    0
  );

  // Look for a payment movement that exactly matches the BF total
  let autoMatchMovementId: string | null = null;
  if (bfTotal !== 0) {
    const absBfTotal = Math.abs(bfTotal);
    for (const mov of movements) {
      // For a liability (credit balance), the clearing payment would be a debit
      const debit = parseFloat(mov.debit || "0");
      const credit = parseFloat(mov.credit || "0");
      // Check if a debit matches the BF total (payment clearing the liability)
      if (Math.abs(debit - absBfTotal) < 0.01 && debit > 0) {
        autoMatchMovementId = mov.id;
        break;
      }
      // Also check credit in case the BF was a debit balance
      if (Math.abs(credit - absBfTotal) < 0.01 && credit > 0) {
        autoMatchMovementId = mov.id;
        break;
      }
    }
  }

  return {
    bfItems,
    bfTotal,
    movements,
    closingItems,
    autoMatchMovementId,
    balance: parseFloat(account.balance),
    periodLabel: `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}`,
  };
}
