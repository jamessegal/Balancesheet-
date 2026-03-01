"use server";

import { db } from "@/lib/db";
import {
  reconciliationAccounts,
  reconciliationPeriods,
  accountTransactions,
  accountNotes,
  reconciliationItems,
  xeroConnections,
  users,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { checkAccountLocked } from "@/lib/period-lock";
import { xeroGet } from "@/lib/xero/client";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// ------------------------------------------------------------------
// Valid status transitions
// ------------------------------------------------------------------
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["in_progress"],
  in_progress: ["ready_for_review"],
  ready_for_review: ["in_progress", "approved"],
  approved: ["reopened"],
  reopened: ["in_progress"],
};

// ------------------------------------------------------------------
// Update account status
// ------------------------------------------------------------------
export async function updateAccountStatus(
  accountId: string,
  newStatus: string
) {
  const session = await requireRole("junior");

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) {
    return { error: "Account not found" };
  }

  const allowed = VALID_TRANSITIONS[account.status] || [];
  if (!allowed.includes(newStatus)) {
    return {
      error: `Cannot transition from ${account.status} to ${newStatus}`,
    };
  }

  // Only managers can approve or reopen
  if (newStatus === "approved" || newStatus === "reopened") {
    await requireRole("manager");
  }

  const updateData: Record<string, unknown> = {
    status: newStatus,
    updatedAt: new Date(),
  };

  if (newStatus === "in_progress" && account.status === "draft") {
    updateData.preparedBy = session.user.id;
  }

  if (newStatus === "approved") {
    updateData.approvedBy = session.user.id;
    updateData.approvedAt = new Date();
  }

  await db
    .update(reconciliationAccounts)
    .set(updateData)
    .where(eq(reconciliationAccounts.id, accountId));

  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, account.periodId))
    .limit(1);

  if (period) {
    revalidatePath(
      `/clients/${period.clientId}/periods/${period.id}/accounts/${accountId}`
    );
    revalidatePath(`/clients/${period.clientId}/periods/${period.id}`);
  }

  return { success: true };
}

// ------------------------------------------------------------------
// Add a note to an account
// ------------------------------------------------------------------
export async function addNote(formData: FormData) {
  const session = await requireRole("junior");

  const accountId = formData.get("accountId") as string;
  const noteType = formData.get("noteType") as string;
  const content = (formData.get("content") as string)?.trim();

  if (!accountId || !noteType || !content) {
    return { error: "All fields are required" };
  }

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) {
    return { error: "Account not found" };
  }

  await db.insert(accountNotes).values({
    reconAccountId: accountId,
    noteType: noteType as "prep" | "review" | "general",
    content,
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
// Get notes for an account (with user names)
// ------------------------------------------------------------------
export async function getAccountNotes(accountId: string) {
  await requireRole("junior");

  return db
    .select({
      id: accountNotes.id,
      noteType: accountNotes.noteType,
      content: accountNotes.content,
      createdAt: accountNotes.createdAt,
      createdByName: users.name,
    })
    .from(accountNotes)
    .leftJoin(users, eq(accountNotes.createdBy, users.id))
    .where(eq(accountNotes.reconAccountId, accountId))
    .orderBy(desc(accountNotes.createdAt));
}

// ------------------------------------------------------------------
// Pull transactions from Xero for an account
// ------------------------------------------------------------------
// The Xero Journals endpoint is incomplete — it doesn't include entries
// for "system accounts" (AR, AP, GST, etc.) and has no date filtering.
// Instead we query the individual transaction endpoints that DO support
// date-range filtering: BankTransactions, ManualJournals, and Invoices.
// Each returns line items with AccountCode which we match to our account.
// ------------------------------------------------------------------

interface XeroBankTransaction {
  BankTransactionID: string;
  Type: string;
  Date: string;
  Reference?: string;
  Status: string;
  Contact?: { Name: string };
  LineItems: {
    LineItemID: string;
    AccountCode: string;
    Description?: string;
    LineAmount: number;
    TaxAmount: number;
  }[];
}

interface XeroManualJournal {
  ManualJournalID: string;
  Date: string;
  Narration?: string;
  Status: string;
  JournalLines: {
    JournalLineID?: string;
    AccountCode: string;
    Description?: string;
    LineAmount: number;
    TaxAmount: number;
  }[];
}

interface XeroInvoice {
  InvoiceID: string;
  Type: string;
  Date: string;
  InvoiceNumber?: string;
  Reference?: string;
  Status: string;
  Contact?: { Name: string };
  LineItems: {
    LineItemID: string;
    AccountCode: string;
    Description?: string;
    LineAmount: number;
    TaxAmount: number;
  }[];
}

interface XeroCreditNote {
  CreditNoteID: string;
  Type: string;
  Date: string;
  CreditNoteNumber?: string;
  Reference?: string;
  Status: string;
  Contact?: { Name: string };
  LineItems: {
    LineItemID: string;
    AccountCode: string;
    Description?: string;
    LineAmount: number;
    TaxAmount: number;
  }[];
}

interface TransactionLine {
  journalLineId: string;
  journalId: string;
  date: string;
  description: string;
  reference: string;
  debit: string;
  credit: string;
  sourceType: string;
  rawData: unknown;
}

export async function pullTransactions(accountId: string) {
  await requireRole("manager");

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) {
    return { error: "Account not found" };
  }

  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, account.periodId))
    .limit(1);

  if (!period) {
    return { error: "Period not found" };
  }

  const [connection] = await db
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.clientId, period.clientId))
    .limit(1);

  if (!connection || connection.status !== "active") {
    return { error: "No active Xero connection" };
  }

  const lastDay = new Date(period.periodYear, period.periodMonth, 0).getDate();

  try {
    let apiCalls = 0;
    const DELAY_MS = 1200; // 1.2s between calls ≈ 50/min
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function xeroCall<T>(path: string): Promise<T> {
      if (apiCalls > 0) await sleep(DELAY_MS);
      apiCalls++;
      const endpoint = path.split("?")[0];
      console.log(`Xero: API call ${apiCalls}, ${endpoint}`);
      return xeroGet<T>(connection.id, connection.xeroTenantId, path);
    }

    // Step 1: Look up the account code from Xero's Chart of Accounts
    console.log(`Xero: Looking up account ${account.xeroAccountId}`);

    const accountResp = await xeroCall<{
      Accounts: { AccountID: string; Code: string; Name: string }[];
    }>(`/Accounts/${account.xeroAccountId}`);

    const xeroAccount = accountResp.Accounts?.[0];
    if (!xeroAccount?.Code) {
      return { error: "Account not found in Xero Chart of Accounts" };
    }

    const accountCode = xeroAccount.Code;
    console.log(
      `Xero: Account code "${accountCode}" (${xeroAccount.Name}), ` +
        `fetching transactions for ${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}`
    );

    // Step 2: Build Xero OData date filter
    const y = period.periodYear;
    const m = period.periodMonth;
    const dateFilter = encodeURIComponent(
      `Date >= DateTime(${y},${m},1) && Date <= DateTime(${y},${m},${lastDay})`
    );

    const allLines: TransactionLine[] = [];

    // ── Helper: parse Xero date formats ──
    // Xero returns dates as either "/Date(ms+tz)/" (.NET) or ISO strings
    function parseXeroDate(raw: string): string {
      const msMatch = raw.match(/\/Date\((\d+)([+-]\d{4})?\)\//);
      if (msMatch) {
        const d = new Date(Number(msMatch[1]));
        return d.toISOString().split("T")[0];
      }
      // ISO format fallback
      return raw.split("T")[0];
    }

    // ── Helper: paginate a Xero endpoint ──
    async function fetchAllPages<T>(
      basePath: string,
      arrayKey: string,
      maxPages = 10
    ): Promise<T[]> {
      const results: T[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const data = await xeroCall<Record<string, T[]>>(
          `${basePath}${basePath.includes("?") ? "&" : "?"}page=${page}`
        );
        const items = data[arrayKey];
        if (!items || items.length === 0) break;
        results.push(...items);
        if (items.length < 100) break;
      }
      return results;
    }

    // ── Step 3: BankTransactions ──
    const bankTxns = await fetchAllPages<XeroBankTransaction>(
      `/BankTransactions?where=${dateFilter}`,
      "BankTransactions"
    );

    for (const txn of bankTxns) {
      if (txn.Status === "DELETED") continue;
      const txnDate = parseXeroDate(txn.Date);

      for (const line of txn.LineItems || []) {
        if (line.AccountCode === accountCode) {
          // SPEND types = debit to the line item account
          // RECEIVE types = credit to the line item account
          const isDebit = txn.Type.startsWith("SPEND");
          const amount = Math.abs(line.LineAmount);
          allLines.push({
            journalLineId: line.LineItemID || txn.BankTransactionID,
            journalId: txn.BankTransactionID,
            date: txnDate,
            description:
              line.Description || txn.Contact?.Name || "",
            reference: txn.Reference || "",
            debit: isDebit ? String(amount) : "0",
            credit: isDebit ? "0" : String(amount),
            sourceType: `BANK-${txn.Type}`,
            rawData: { bankTransaction: txn, lineItem: line },
          });
        }
      }
    }
    console.log(
      `Xero: BankTransactions — ${bankTxns.length} total, ${allLines.length} lines match account ${accountCode}`
    );

    // ── Step 4: ManualJournals ──
    const prevCount = allLines.length;
    const manualJournals = await fetchAllPages<XeroManualJournal>(
      `/ManualJournals?where=${dateFilter}`,
      "ManualJournals"
    );

    for (const mj of manualJournals) {
      if (mj.Status === "VOIDED") continue;
      const mjDate = parseXeroDate(mj.Date);

      for (const line of mj.JournalLines || []) {
        if (line.AccountCode === accountCode) {
          // ManualJournal: positive LineAmount = debit, negative = credit
          const amount = line.LineAmount;
          allLines.push({
            journalLineId: line.JournalLineID || mj.ManualJournalID,
            journalId: mj.ManualJournalID,
            date: mjDate,
            description: line.Description || mj.Narration || "",
            reference: mj.Narration || "",
            debit: amount > 0 ? String(amount) : "0",
            credit: amount < 0 ? String(Math.abs(amount)) : "0",
            sourceType: "MANJOURNAL",
            rawData: { manualJournal: mj, journalLine: line },
          });
        }
      }
    }
    console.log(
      `Xero: ManualJournals — ${manualJournals.length} total, ${allLines.length - prevCount} lines match`
    );

    // ── Step 5: Invoices (bills & sales invoices with line items coded to this account) ──
    const prevCount2 = allLines.length;
    const invoices = await fetchAllPages<XeroInvoice>(
      `/Invoices?where=${dateFilter}`,
      "Invoices"
    );

    for (const inv of invoices) {
      if (inv.Status === "DELETED" || inv.Status === "VOIDED") continue;
      const invDate = parseXeroDate(inv.Date);

      for (const line of inv.LineItems || []) {
        if (line.AccountCode === accountCode) {
          // ACCPAY (purchase bill): line items are debits to the coded account
          // ACCREC (sales invoice): line items are credits to the coded account
          const isDebit = inv.Type === "ACCPAY";
          const amount = Math.abs(line.LineAmount);
          allLines.push({
            journalLineId: line.LineItemID || inv.InvoiceID,
            journalId: inv.InvoiceID,
            date: invDate,
            description:
              line.Description || inv.Contact?.Name || "",
            reference: inv.InvoiceNumber || inv.Reference || "",
            debit: isDebit ? String(amount) : "0",
            credit: isDebit ? "0" : String(amount),
            sourceType: `INVOICE-${inv.Type}`,
            rawData: { invoice: inv, lineItem: line },
          });
        }
      }
    }
    console.log(
      `Xero: Invoices — ${invoices.length} total, ${allLines.length - prevCount2} lines match`
    );

    // ── Step 6: CreditNotes (reverse of invoices) ──
    const prevCount3 = allLines.length;
    const creditNotes = await fetchAllPages<XeroCreditNote>(
      `/CreditNotes?where=${dateFilter}`,
      "CreditNotes"
    );

    for (const cn of creditNotes) {
      if (cn.Status === "DELETED" || cn.Status === "VOIDED") continue;
      const cnDate = parseXeroDate(cn.Date);

      for (const line of cn.LineItems || []) {
        if (line.AccountCode === accountCode) {
          // ACCPAYCREDIT: line items are credits (reverses a bill debit)
          // ACCRECCREDIT: line items are debits (reverses a sales credit)
          const isDebit = cn.Type === "ACCRECCREDIT";
          const amount = Math.abs(line.LineAmount);
          allLines.push({
            journalLineId: line.LineItemID || cn.CreditNoteID,
            journalId: cn.CreditNoteID,
            date: cnDate,
            description:
              line.Description || cn.Contact?.Name || "",
            reference: cn.CreditNoteNumber || cn.Reference || "",
            debit: isDebit ? String(amount) : "0",
            credit: isDebit ? "0" : String(amount),
            sourceType: `CREDITNOTE-${cn.Type}`,
            rawData: { creditNote: cn, lineItem: line },
          });
        }
      }
    }
    console.log(
      `Xero: CreditNotes — ${creditNotes.length} total, ${allLines.length - prevCount3} lines match`
    );

    console.log(
      `Xero: Done — ${apiCalls} API calls, found ${allLines.length} total transactions for account ${accountCode}`
    );

    // ── Save to database ──
    await db
      .delete(accountTransactions)
      .where(eq(accountTransactions.reconAccountId, accountId));

    if (allLines.length > 0) {
      await db.insert(accountTransactions).values(
        allLines.map((line) => ({
          reconAccountId: accountId,
          xeroLineItemId: line.journalLineId,
          xeroJournalId: line.journalId,
          transactionDate: line.date,
          description: line.description,
          reference: line.reference,
          debit: line.debit,
          credit: line.credit,
          sourceType: line.sourceType,
          rawData: line.rawData,
        }))
      );
    }

    await db
      .update(reconciliationAccounts)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(reconciliationAccounts.id, accountId));

    revalidatePath(
      `/clients/${period.clientId}/periods/${period.id}/accounts/${accountId}`
    );

    return { success: true, transactionCount: allLines.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: `Failed to pull transactions: ${message}` };
  }
}

// ------------------------------------------------------------------
// Reconciliation Items — manual schedule items that explain a balance
// ------------------------------------------------------------------

export async function addReconciliationItem(formData: FormData) {
  const session = await requireRole("junior");

  const accountId = formData.get("accountId") as string;
  const description = (formData.get("description") as string)?.trim();
  const amountStr = (formData.get("amount") as string)?.trim();
  const itemDate = (formData.get("itemDate") as string)?.trim() || null;

  if (!accountId || !description || !amountStr) {
    return { error: "Description and amount are required" };
  }

  // Check if account is locked (approved)
  const lockError = await checkAccountLocked(accountId);
  if (lockError) return { error: lockError };

  const amount = parseFloat(amountStr);
  if (isNaN(amount)) {
    return { error: "Amount must be a valid number" };
  }

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) {
    return { error: "Account not found" };
  }

  // Validate date is within the period month if provided
  if (itemDate) {
    const [period] = await db
      .select()
      .from(reconciliationPeriods)
      .where(eq(reconciliationPeriods.id, account.periodId))
      .limit(1);

    if (period) {
      const d = new Date(itemDate);
      if (d.getFullYear() !== period.periodYear || d.getMonth() + 1 !== period.periodMonth) {
        return { error: "Date must be within the reconciliation period month" };
      }
    }
  }

  await db.insert(reconciliationItems).values({
    reconAccountId: accountId,
    description,
    amount: String(amount),
    itemDate,
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

export async function deleteReconciliationItem(itemId: string) {
  await requireRole("junior");

  const [item] = await db
    .select()
    .from(reconciliationItems)
    .where(eq(reconciliationItems.id, itemId))
    .limit(1);

  if (!item) {
    return { error: "Item not found" };
  }

  // Check if account is locked
  const lockError = await checkAccountLocked(item.reconAccountId);
  if (lockError) return { error: lockError };

  await db
    .delete(reconciliationItems)
    .where(eq(reconciliationItems.id, itemId));

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
