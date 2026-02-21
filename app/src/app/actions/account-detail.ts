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
    // Fetch journals for this account within the period date range.
    // Xero Journals API only paginates forward by journal number (no date filter),
    // so we use exponential probing + binary search to jump to the right date range
    // instead of scanning from journal #0 (which can be thousands of wasted calls).
    let apiCalls = 0;
    const MAX_API_CALLS = 30;
    const DELAY_MS = 1200; // 1.2s between calls = ~50/min

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

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function fetchPage(offset: number): Promise<XeroJournalsResponse> {
      if (apiCalls > 0) await sleep(DELAY_MS);
      apiCalls++;
      console.log(`Xero: API call ${apiCalls}/${MAX_API_CALLS}, offset=${offset}`);
      return xeroGet<XeroJournalsResponse>(
        connection.id,
        connection.xeroTenantId,
        `/Journals?offset=${offset}&pastPayments=true`
      );
    }

    function lastDateOf(journals: XeroJournal[]) {
      return journals[journals.length - 1].JournalDate.split("T")[0];
    }

    function lastNumOf(journals: XeroJournal[]) {
      return journals[journals.length - 1].JournalNumber;
    }

    console.log(`Xero: Searching for journals between ${startDate} and ${endDate}, account ${account.xeroAccountId}`);

    // ── Phase 1: Exponential probe to bracket the start date ──
    // Jump forward by doubling steps until we find journals at/past startDate
    let low = 0;
    let high = 0;
    let step = 100;

    while (apiCalls < MAX_API_CALLS) {
      const data = await fetchPage(high);

      if (!data.Journals || data.Journals.length === 0) {
        // Past all journals — bracket is [low, high]
        console.log(`Xero: No journals at offset=${high}, total range is [0, ${high}]`);
        break;
      }

      const batchLastDate = lastDateOf(data.Journals);
      const batchLastNum = lastNumOf(data.Journals);

      if (batchLastDate >= startDate) {
        // Found the bracket — journals before `low` are too early,
        // journals at `high` include our date range
        console.log(`Xero: Bracketed date range to offsets [${low}, ${high}]`);
        break;
      }

      // Everything in this batch is still before our date range, jump further
      low = batchLastNum;
      step = Math.min(step * 2, 10000); // double the jump, cap at 10k
      high = low + step;
    }

    // ── Phase 2: Binary search to narrow down the start ──
    // Find the lowest offset where journals have dates >= startDate
    while (high - low > 100 && apiCalls < MAX_API_CALLS) {
      const mid = Math.floor((low + high) / 2);
      const data = await fetchPage(mid);

      if (!data.Journals || data.Journals.length === 0) {
        high = mid;
        continue;
      }

      if (lastDateOf(data.Journals) < startDate) {
        low = lastNumOf(data.Journals);
      } else {
        high = mid;
      }
    }

    console.log(`Xero: Narrowed start to offset=${low}, beginning collection`);

    // ── Phase 3: Paginate forward through the date range ──
    let offset = low;
    let hasMore = true;
    let journalsInRange = 0;
    const seenAccountIds = new Set<string>();

    while (hasMore && apiCalls < MAX_API_CALLS) {
      const data = await fetchPage(offset);

      if (!data.Journals || data.Journals.length === 0) {
        break;
      }

      for (const journal of data.Journals) {
        const journalDate = journal.JournalDate.split("T")[0];

        if (journalDate < startDate) continue;
        if (journalDate > endDate) {
          hasMore = false;
          break;
        }

        journalsInRange++;
        for (const line of journal.JournalLines) {
          // Collect unique account IDs for diagnostics (first 200 journals only)
          if (journalsInRange <= 200) {
            seenAccountIds.add(line.AccountID);
          }

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

      offset = lastNumOf(data.Journals);
    }

    console.log(`Xero: Done — ${apiCalls} API calls, ${journalsInRange} journals in date range, found ${allLines.length} matching transactions`);
    console.log(`Xero: Looking for account ID: ${account.xeroAccountId}`);
    console.log(`Xero: Unique account IDs seen in journals: ${seenAccountIds.size}`);
    if (allLines.length === 0 && seenAccountIds.size > 0) {
      // Log a sample of IDs to help diagnose mismatch
      const sample = [...seenAccountIds].slice(0, 10);
      console.log(`Xero: Sample account IDs from journals: ${sample.join(", ")}`);
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
