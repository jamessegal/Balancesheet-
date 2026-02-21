"use server";

import { db } from "@/lib/db";
import {
  reconciliationAccounts,
  reconciliationPeriods,
  accountTransactions,
  accountNotes,
  xeroConnections,
  users,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { xeroGet } from "@/lib/xero/client";
import { eq, and, desc } from "drizzle-orm";
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

interface XeroJournalLine {
  JournalLineID: string;
  AccountID: string;
  AccountCode: string;
  AccountName: string;
  NetAmount: number;
  GrossAmount: number;
  TaxAmount: number;
  Description?: string;
}

interface XeroJournal {
  JournalID: string;
  JournalDate: string;
  JournalNumber: number;
  Reference?: string;
  SourceType?: string;
  JournalLines: XeroJournalLine[];
}

interface XeroJournalsResponse {
  Journals: XeroJournal[];
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

  // Date range for the period
  const startDate = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(period.periodYear, period.periodMonth, 0).getDate();
  const endDate = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  try {
    // Fetch journals and filter for this account
    let offset = 0;
    const allLines: {
      journalLineId: string;
      journalId: string;
      date: string;
      description: string;
      reference: string;
      debit: string;
      credit: string;
      sourceType: string;
      rawData: unknown;
    }[] = [];

    // Xero journals API paginates with offset
    let hasMore = true;
    while (hasMore) {
      const data = await xeroGet<XeroJournalsResponse>(
        connection.id,
        connection.xeroTenantId,
        `/Journals?offset=${offset}&pastPayments=true`
      );

      if (!data.Journals || data.Journals.length === 0) {
        hasMore = false;
        break;
      }

      for (const journal of data.Journals) {
        const journalDate = journal.JournalDate.split("T")[0];

        // Filter by date range
        if (journalDate < startDate) {
          continue;
        }
        if (journalDate > endDate) {
          // Journals are in chronological order, so we can stop
          hasMore = false;
          break;
        }

        // Find lines for this specific account
        for (const line of journal.JournalLines) {
          if (line.AccountID === account.xeroAccountId) {
            const amount = line.NetAmount || 0;
            allLines.push({
              journalLineId: line.JournalLineID,
              journalId: journal.JournalID,
              date: journalDate,
              description: line.Description || "",
              reference: journal.Reference || "",
              debit: amount > 0 ? String(amount) : "0",
              credit: amount < 0 ? String(Math.abs(amount)) : "0",
              sourceType: journal.SourceType || "",
              rawData: { journal, line },
            });
          }
        }
      }

      offset = data.Journals[data.Journals.length - 1].JournalNumber;
    }

    // Clear existing transactions for this account and insert new ones
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

    // Update last synced
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
