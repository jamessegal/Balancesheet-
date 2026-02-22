"use server";

import { db } from "@/lib/db";
import {
  reconciliationAccounts,
  reconciliationPeriods,
  bankReconStatements,
  bankReconItems,
  xeroConnections,
  users,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { xeroGet } from "@/lib/xero/client";

// ------------------------------------------------------------------
// Load all bank recon data for a given reconciliation account
// ------------------------------------------------------------------
export async function loadBankReconData(accountId: string) {
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

  // Load existing statement record (if any)
  let statement: {
    id: string;
    statementDate: string;
    statementBalance: string;
    glBalance: string;
    currency: string;
    documentFileName: string | null;
    status: string;
    notes: string | null;
    confirmedByName: string | null;
    confirmedAt: Date | null;
  } | null = null;

  try {
    const rows = await db
      .select({
        id: bankReconStatements.id,
        statementDate: bankReconStatements.statementDate,
        statementBalance: bankReconStatements.statementBalance,
        glBalance: bankReconStatements.glBalance,
        currency: bankReconStatements.currency,
        documentFileName: bankReconStatements.documentFileName,
        status: bankReconStatements.status,
        notes: bankReconStatements.notes,
        confirmedByName: users.name,
        confirmedAt: bankReconStatements.confirmedAt,
      })
      .from(bankReconStatements)
      .leftJoin(users, eq(bankReconStatements.confirmedBy, users.id))
      .where(eq(bankReconStatements.reconAccountId, accountId))
      .limit(1);

    if (rows.length > 0) {
      statement = rows[0];
    }
  } catch {
    // Table may not exist yet
  }

  // Load reconciling items
  let reconItems: {
    id: string;
    itemType: string;
    description: string;
    amount: string;
    transactionDate: string | null;
    reference: string | null;
    xeroTransactionId: string | null;
    source: string;
    isTicked: boolean;
  }[] = [];

  try {
    reconItems = await db
      .select({
        id: bankReconItems.id,
        itemType: bankReconItems.itemType,
        description: bankReconItems.description,
        amount: bankReconItems.amount,
        transactionDate: bankReconItems.transactionDate,
        reference: bankReconItems.reference,
        xeroTransactionId: bankReconItems.xeroTransactionId,
        source: bankReconItems.source,
        isTicked: bankReconItems.isTicked,
      })
      .from(bankReconItems)
      .where(eq(bankReconItems.reconAccountId, accountId))
      .orderBy(bankReconItems.createdAt);
  } catch {
    // Table may not exist yet
  }

  // Calculate the month-end date for this period
  const lastDay = new Date(period.periodYear, period.periodMonth, 0).getDate();
  const monthEndDate = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  return {
    statement,
    reconItems,
    glBalance: parseFloat(account.balance),
    monthEndDate,
    periodLabel: `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}`,
    periodYear: period.periodYear,
    periodMonth: period.periodMonth,
    clientId: period.clientId,
  };
}

// ------------------------------------------------------------------
// Save or update the bank statement details
// ------------------------------------------------------------------
export async function saveBankReconStatement(formData: FormData) {
  const session = await requireRole("junior");

  const accountId = formData.get("accountId") as string;
  const statementDate = formData.get("statementDate") as string;
  const statementBalanceStr = formData.get("statementBalance") as string;
  const currency = (formData.get("currency") as string) || "GBP";
  const notes = (formData.get("notes") as string)?.trim() || null;

  if (!accountId || !statementDate || !statementBalanceStr) {
    return { error: "Statement date and balance are required" };
  }

  const statementBalance = parseFloat(statementBalanceStr);
  if (isNaN(statementBalance)) {
    return { error: "Statement balance must be a valid number" };
  }

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

  const glBalance = parseFloat(account.balance);
  const variance = Math.abs(statementBalance - glBalance);
  const isMatched = variance < 0.005; // zero tolerance (rounding only)

  // Determine status
  // Check if statement date matches month-end
  const lastDay = new Date(period.periodYear, period.periodMonth, 0).getDate();
  const monthEndDate = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const dateMatches = statementDate === monthEndDate;

  let status: string;
  if (isMatched && dateMatches) {
    status = "matched";
  } else if (isMatched && !dateMatches) {
    status = "needs_review"; // date mismatch
  } else {
    status = "mismatched";
  }

  // Upsert statement record
  const [existing] = await db
    .select()
    .from(bankReconStatements)
    .where(eq(bankReconStatements.reconAccountId, accountId))
    .limit(1);

  if (existing) {
    await db
      .update(bankReconStatements)
      .set({
        statementDate,
        statementBalance: String(statementBalance),
        glBalance: String(glBalance),
        currency,
        status,
        notes,
        confirmedBy: isMatched ? session.user.id : null,
        confirmedAt: isMatched ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(bankReconStatements.id, existing.id));
  } else {
    await db.insert(bankReconStatements).values({
      reconAccountId: accountId,
      statementDate,
      statementBalance: String(statementBalance),
      glBalance: String(glBalance),
      currency,
      status,
      notes,
      confirmedBy: isMatched ? session.user.id : null,
      confirmedAt: isMatched ? new Date() : null,
      createdBy: session.user.id,
    });
  }

  revalidatePath(
    `/clients/${period.clientId}/periods/${period.id}/accounts/${accountId}`
  );

  return { success: true, status, variance };
}

// ------------------------------------------------------------------
// Fetch unreconciled bank transactions from Xero
// ------------------------------------------------------------------
export async function fetchUnreconciledBankItems(accountId: string) {
  await requireRole("manager");

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

  const [connection] = await db
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.clientId, period.clientId))
    .limit(1);

  if (!connection || connection.status !== "active") {
    return { error: "No active Xero connection" };
  }

  try {
    // Get bank account code from Xero
    const accountResp = await xeroGet<{
      Accounts: {
        AccountID: string;
        Code: string;
        Name: string;
        CurrencyCode?: string;
        BankAccountNumber?: string;
      }[];
    }>(connection.id, connection.xeroTenantId, `/Accounts/${account.xeroAccountId}`);

    const xeroAccount = accountResp.Accounts?.[0];
    if (!xeroAccount) {
      return { error: "Account not found in Xero" };
    }

    // Fetch unreconciled bank transactions for this bank account
    const lastDay = new Date(period.periodYear, period.periodMonth, 0).getDate();
    const y = period.periodYear;
    const m = period.periodMonth;
    const dateFilter = encodeURIComponent(
      `BankAccount.AccountID==guid("${account.xeroAccountId}") && IsReconciled==false && Date <= DateTime(${y},${m},${lastDay})`
    );

    const resp = await xeroGet<{
      BankTransactions: {
        BankTransactionID: string;
        Type: string;
        Date: string;
        Reference?: string;
        Status: string;
        Contact?: { Name: string };
        Total: number;
        SubTotal: number;
        LineItems: {
          Description?: string;
          LineAmount: number;
        }[];
      }[];
    }>(connection.id, connection.xeroTenantId, `/BankTransactions?where=${dateFilter}`);

    const transactions = (resp.BankTransactions || [])
      .filter((t) => t.Status !== "DELETED")
      .map((t) => {
        // Parse Xero date
        const msMatch = t.Date.match(/\/Date\((\d+)([+-]\d{4})?\)\//);
        const txnDate = msMatch
          ? new Date(Number(msMatch[1])).toISOString().split("T")[0]
          : t.Date.split("T")[0];

        const isSpend = t.Type.startsWith("SPEND");
        const amount = isSpend ? -Math.abs(t.Total) : Math.abs(t.Total);
        const description =
          t.LineItems?.[0]?.Description ||
          t.Contact?.Name ||
          t.Reference ||
          t.Type;

        return {
          xeroTransactionId: t.BankTransactionID,
          description,
          amount,
          transactionDate: txnDate,
          reference: t.Reference || "",
          itemType: isSpend ? "unpresented_payment" : "outstanding_deposit",
        };
      });

    revalidatePath(
      `/clients/${period.clientId}/periods/${period.id}/accounts/${accountId}`
    );

    return {
      success: true,
      transactions,
      currency: xeroAccount.CurrencyCode || "GBP",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: `Failed to fetch from Xero: ${message}` };
  }
}

// ------------------------------------------------------------------
// Add reconciling items (from Xero fetch or manual entry)
// ------------------------------------------------------------------
export async function addBankReconItem(formData: FormData) {
  const session = await requireRole("junior");

  const accountId = formData.get("accountId") as string;
  const description = (formData.get("description") as string)?.trim();
  const amountStr = (formData.get("amount") as string)?.trim();
  const itemType = (formData.get("itemType") as string) || "other";
  const transactionDate = (formData.get("transactionDate") as string) || null;
  const reference = (formData.get("reference") as string) || null;
  const xeroTransactionId = (formData.get("xeroTransactionId") as string) || null;
  const source = (formData.get("source") as string) || "manual";

  if (!accountId || !description || !amountStr) {
    return { error: "Description and amount are required" };
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount)) {
    return { error: "Amount must be a valid number" };
  }

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) return { error: "Account not found" };

  await db.insert(bankReconItems).values({
    reconAccountId: accountId,
    itemType,
    description,
    amount: String(amount),
    transactionDate,
    reference,
    xeroTransactionId,
    source,
    createdBy: session.user.id,
  });

  // Update statement status if items now explain the variance
  await recalculateReconStatus(accountId);

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
// Bulk add reconciling items from Xero auto-fetch
// ------------------------------------------------------------------
export async function bulkAddBankReconItems(
  accountId: string,
  items: {
    description: string;
    amount: number;
    transactionDate: string;
    reference: string;
    xeroTransactionId: string;
    itemType: string;
  }[]
) {
  const session = await requireRole("junior");

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) return { error: "Account not found" };

  if (items.length > 0) {
    await db.insert(bankReconItems).values(
      items.map((item) => ({
        reconAccountId: accountId,
        itemType: item.itemType,
        description: item.description,
        amount: String(item.amount),
        transactionDate: item.transactionDate,
        reference: item.reference,
        xeroTransactionId: item.xeroTransactionId,
        source: "xero_auto" as const,
        createdBy: session.user.id,
      }))
    );
  }

  await recalculateReconStatus(accountId);

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
// Toggle a reconciling item's ticked state
// ------------------------------------------------------------------
export async function toggleBankReconItem(itemId: string, isTicked: boolean) {
  await requireRole("junior");

  const [item] = await db
    .select()
    .from(bankReconItems)
    .where(eq(bankReconItems.id, itemId))
    .limit(1);

  if (!item) return { error: "Item not found" };

  await db
    .update(bankReconItems)
    .set({ isTicked })
    .where(eq(bankReconItems.id, itemId));

  await recalculateReconStatus(item.reconAccountId);

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, item.reconAccountId))
    .limit(1);

  if (account) {
    const [period] = await db
      .select()
      .from(reconciliationPeriods)
      .where(eq(reconciliationPeriods.id, account.periodId))
      .limit(1);

    if (period) {
      revalidatePath(
        `/clients/${period.clientId}/periods/${period.id}/accounts/${account.id}`
      );
    }
  }

  return { success: true };
}

// ------------------------------------------------------------------
// Delete a reconciling item
// ------------------------------------------------------------------
export async function deleteBankReconItem(itemId: string) {
  await requireRole("junior");

  const [item] = await db
    .select()
    .from(bankReconItems)
    .where(eq(bankReconItems.id, itemId))
    .limit(1);

  if (!item) return { error: "Item not found" };

  await db
    .delete(bankReconItems)
    .where(eq(bankReconItems.id, itemId));

  await recalculateReconStatus(item.reconAccountId);

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, item.reconAccountId))
    .limit(1);

  if (account) {
    const [period] = await db
      .select()
      .from(reconciliationPeriods)
      .where(eq(reconciliationPeriods.id, account.periodId))
      .limit(1);

    if (period) {
      revalidatePath(
        `/clients/${period.clientId}/periods/${period.id}/accounts/${account.id}`
      );
    }
  }

  return { success: true };
}

// ------------------------------------------------------------------
// Upload a bank statement document (stored as base64 in DB)
// ------------------------------------------------------------------
export async function uploadBankStatement(formData: FormData) {
  await requireRole("junior");

  const accountId = formData.get("accountId") as string;
  const file = formData.get("file") as File | null;

  if (!accountId || !file) {
    return { error: "Account ID and file are required" };
  }

  // Validate file size (5MB max)
  if (file.size > 5 * 1024 * 1024) {
    return { error: "File must be smaller than 5MB" };
  }

  // Validate file type
  const allowedTypes = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
  ];
  if (!allowedTypes.includes(file.type)) {
    return { error: "File type not supported. Use PDF, PNG, JPG, Excel or CSV." };
  }

  const [statement] = await db
    .select()
    .from(bankReconStatements)
    .where(eq(bankReconStatements.reconAccountId, accountId))
    .limit(1);

  if (!statement) {
    return { error: "Save the statement details first before uploading a document" };
  }

  // Read file as base64
  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");

  await db
    .update(bankReconStatements)
    .set({
      documentFileName: file.name,
      documentData: base64,
      documentMimeType: file.type,
      updatedAt: new Date(),
    })
    .where(eq(bankReconStatements.id, statement.id));

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (account) {
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
  }

  return { success: true };
}

// ------------------------------------------------------------------
// Delete a bank statement document
// ------------------------------------------------------------------
export async function deleteBankStatementFile(statementId: string) {
  await requireRole("junior");

  const [statement] = await db
    .select()
    .from(bankReconStatements)
    .where(eq(bankReconStatements.id, statementId))
    .limit(1);

  if (!statement) {
    return { error: "Statement not found" };
  }

  await db
    .update(bankReconStatements)
    .set({
      documentFileName: null,
      documentData: null,
      documentMimeType: null,
      updatedAt: new Date(),
    })
    .where(eq(bankReconStatements.id, statementId));

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, statement.reconAccountId))
    .limit(1);

  if (account) {
    const [period] = await db
      .select()
      .from(reconciliationPeriods)
      .where(eq(reconciliationPeriods.id, account.periodId))
      .limit(1);

    if (period) {
      revalidatePath(
        `/clients/${period.clientId}/periods/${period.id}/accounts/${account.id}`
      );
    }
  }

  return { success: true };
}

// ------------------------------------------------------------------
// Internal: recalculate recon status based on ticked items
// ------------------------------------------------------------------
async function recalculateReconStatus(accountId: string) {
  const [statement] = await db
    .select()
    .from(bankReconStatements)
    .where(eq(bankReconStatements.reconAccountId, accountId))
    .limit(1);

  if (!statement) return;

  const items = await db
    .select()
    .from(bankReconItems)
    .where(eq(bankReconItems.reconAccountId, accountId));

  const tickedTotal = items
    .filter((i) => i.isTicked)
    .reduce((sum, i) => sum + parseFloat(i.amount), 0);

  const stmtBal = parseFloat(statement.statementBalance);
  const glBal = parseFloat(statement.glBalance);
  const variance = stmtBal - glBal;
  const adjustedVariance = Math.abs(variance - tickedTotal);
  const reconciledWithItems = adjustedVariance < 0.005;

  const allItemsTotal = items.reduce(
    (sum, i) => sum + parseFloat(i.amount),
    0
  );
  const fullyExplained = Math.abs(variance - allItemsTotal) < 0.005;

  let newStatus = statement.status;
  if (Math.abs(variance) < 0.005) {
    // Already matched — don't change status based on items
    return;
  }

  if (reconciledWithItems) {
    newStatus = "reconciled_with_items";
  } else if (items.length > 0) {
    newStatus = "mismatched"; // has items but they don't fully explain
  } else {
    newStatus = "mismatched";
  }

  if (newStatus !== statement.status) {
    await db
      .update(bankReconStatements)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(bankReconStatements.id, statement.id));
  }
}
