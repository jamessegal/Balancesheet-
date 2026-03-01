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
    itemDate: string | null;
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
          itemDate: reconciliationItems.itemDate,
        })
        .from(reconciliationItems)
        .where(eq(reconciliationItems.reconAccountId, priorAccount.id))
        .orderBy(reconciliationItems.createdAt);
    }
  }

  // If BF doesn't already contain a rounding item, walk back through earlier
  // periods to find one. Rounding items persist until cleared by a journal
  // (which appears as a GL movement), so they must carry forward even if the
  // intermediate period didn't explicitly save them as closing items.
  const bfHasRounding = bfItems.some((item) =>
    item.description.toLowerCase().includes("rounding")
  );
  if (!bfHasRounding) {
    let walkMonth = priorMonth;
    let walkYear = priorYear;
    for (let i = 0; i < 24; i++) {
      const prevMonth = walkMonth === 1 ? 12 : walkMonth - 1;
      const prevYear = walkMonth === 1 ? walkYear - 1 : walkYear;

      const [prevPeriod] = await db
        .select()
        .from(reconciliationPeriods)
        .where(
          and(
            eq(reconciliationPeriods.clientId, period.clientId),
            eq(reconciliationPeriods.periodYear, prevYear),
            eq(reconciliationPeriods.periodMonth, prevMonth)
          )
        )
        .limit(1);

      if (!prevPeriod) break;

      const [prevAccount] = await db
        .select()
        .from(reconciliationAccounts)
        .where(
          and(
            eq(reconciliationAccounts.periodId, prevPeriod.id),
            eq(reconciliationAccounts.xeroAccountId, account.xeroAccountId)
          )
        )
        .limit(1);

      if (!prevAccount) break;

      const prevItems = await db
        .select({
          id: reconciliationItems.id,
          description: reconciliationItems.description,
          amount: reconciliationItems.amount,
          itemDate: reconciliationItems.itemDate,
        })
        .from(reconciliationItems)
        .where(eq(reconciliationItems.reconAccountId, prevAccount.id));

      const roundingItems = prevItems.filter((item) =>
        item.description.toLowerCase().includes("rounding")
      );

      if (roundingItems.length > 0) {
        for (const ri of roundingItems) {
          bfItems.push({
            id: ri.id,
            description: ri.description,
            amount: ri.amount,
            itemDate: ri.itemDate,
          });
        }
        break;
      }

      walkMonth = prevMonth;
      walkYear = prevYear;
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
    itemDate: string | null;
    glTransactionId: string | null;
    createdByName: string | null;
  }[] = [];

  try {
    closingItems = await db
      .select({
        id: reconciliationItems.id,
        description: reconciliationItems.description,
        amount: reconciliationItems.amount,
        itemDate: reconciliationItems.itemDate,
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

  // 4. Smart auto-match detection
  // Find debit payment(s) that best clear the BF total. Supports:
  //   - Single exact match
  //   - Single near-match (within £1 for rounding)
  //   - Multiple payments that sum to BF
  const bfTotal = bfItems.reduce(
    (sum, item) => sum + parseFloat(item.amount || "0"),
    0
  );

  // suggestedPaymentMatches: map of movementId → amount allocated to BF
  let suggestedPaymentMatches: Record<string, number> = {};

  if (bfTotal !== 0) {
    const absBfTotal = Math.abs(bfTotal);
    const debits = movements
      .map((mov) => ({
        id: mov.id,
        amount: parseFloat(mov.debit || "0"),
      }))
      .filter((d) => d.amount > 0);

    // Strategy 1: single exact match (within £0.01)
    const exactMatch = debits.find(
      (d) => Math.abs(d.amount - absBfTotal) < 0.01
    );
    if (exactMatch) {
      suggestedPaymentMatches = { [exactMatch.id]: exactMatch.amount };
    }

    // Strategy 2: single near-match (within £1 — rounding)
    if (Object.keys(suggestedPaymentMatches).length === 0) {
      const nearMatch = debits.find(
        (d) => Math.abs(d.amount - absBfTotal) <= 1.0
      );
      if (nearMatch) {
        suggestedPaymentMatches = { [nearMatch.id]: nearMatch.amount };
      }
    }

    // Strategy 3: combination of payments that sum to BF (within £1)
    // Try pairs first, then all debits
    if (Object.keys(suggestedPaymentMatches).length === 0 && debits.length >= 2) {
      // Try pairs
      for (let i = 0; i < debits.length; i++) {
        for (let j = i + 1; j < debits.length; j++) {
          const pairSum = debits[i].amount + debits[j].amount;
          if (Math.abs(pairSum - absBfTotal) <= 1.0) {
            suggestedPaymentMatches = {
              [debits[i].id]: debits[i].amount,
              [debits[j].id]: debits[j].amount,
            };
            break;
          }
        }
        if (Object.keys(suggestedPaymentMatches).length > 0) break;
      }

      // Try all debits together
      if (Object.keys(suggestedPaymentMatches).length === 0) {
        const allSum = debits.reduce((s, d) => s + d.amount, 0);
        if (Math.abs(allSum - absBfTotal) <= 1.0) {
          for (const d of debits) {
            suggestedPaymentMatches[d.id] = d.amount;
          }
        }
      }
    }
  }

  return {
    bfItems,
    bfTotal,
    movements,
    closingItems,
    suggestedPaymentMatches,
    balance: parseFloat(account.balance),
    periodLabel: `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}`,
  };
}
