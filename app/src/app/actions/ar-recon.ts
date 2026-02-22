"use server";

import { db } from "@/lib/db";
import {
  reconciliationAccounts,
  reconciliationPeriods,
  xeroConnections,
  arReconciliations,
  arInvoiceSnapshots,
  arAuditLog,
  users,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { xeroGet } from "@/lib/xero/client";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";
type RiskFlag = "none" | "watch" | "high";

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Contact: { Name: string };
  Date: string;
  DueDate: string;
  Total: number;
  AmountDue: number;
  Status: string;
  Type: string;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function monthEndDate(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** Parse Xero's /Date(...)/ format or ISO date string to YYYY-MM-DD */
function parseXeroDate(dateStr: string): string {
  const msMatch = dateStr.match(/\/Date\((\d+)([+-]\d{4})?\)\//);
  if (msMatch) {
    return new Date(Number(msMatch[1])).toISOString().split("T")[0];
  }
  return dateStr.split("T")[0];
}

/** Calculate aging bucket and days overdue for an invoice as at a given date */
function calculateAging(
  dueDate: string,
  asAtDate: string
): { bucket: AgingBucket; daysOverdue: number; requiresComment: boolean } {
  const due = new Date(dueDate + "T00:00:00");
  const asAt = new Date(asAtDate + "T00:00:00");
  const diffMs = asAt.getTime() - due.getTime();
  const daysOverdue = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

  let bucket: AgingBucket;
  let requiresComment: boolean;

  if (daysOverdue === 0) {
    bucket = "current";
    requiresComment = false;
  } else if (daysOverdue <= 30) {
    bucket = "1_30";
    requiresComment = false;
  } else if (daysOverdue <= 60) {
    bucket = "31_60";
    requiresComment = false;
  } else if (daysOverdue <= 90) {
    bucket = "61_90";
    requiresComment = false;
  } else {
    bucket = "90_plus";
    requiresComment = true; // 90+ days MUST have comment
  }

  return { bucket, daysOverdue, requiresComment };
}

// ------------------------------------------------------------------
// Load AR reconciliation data for a given account
// ------------------------------------------------------------------
export async function loadARReconData(accountId: string) {
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

  const meDate = monthEndDate(period.periodYear, period.periodMonth);

  // Load existing AR reconciliation
  let recon: {
    id: string;
    monthEndDate: string;
    ledgerBalance: string;
    agedReportTotal: string | null;
    variance: string | null;
    status: string;
    signedOffByName: string | null;
    signedOffAt: Date | null;
  } | null = null;

  try {
    const rows = await db
      .select({
        id: arReconciliations.id,
        monthEndDate: arReconciliations.monthEndDate,
        ledgerBalance: arReconciliations.ledgerBalance,
        agedReportTotal: arReconciliations.agedReportTotal,
        variance: arReconciliations.variance,
        status: arReconciliations.status,
        signedOffByName: users.name,
        signedOffAt: arReconciliations.signedOffAt,
      })
      .from(arReconciliations)
      .leftJoin(users, eq(arReconciliations.signedOffBy, users.id))
      .where(eq(arReconciliations.reconAccountId, accountId))
      .limit(1);

    if (rows.length > 0) {
      recon = rows[0];
    }
  } catch {
    // Table may not exist yet
  }

  // Load invoice snapshots
  let invoices: {
    id: string;
    xeroInvoiceId: string | null;
    invoiceNumber: string | null;
    contactName: string;
    invoiceDate: string | null;
    dueDate: string | null;
    originalAmount: string;
    outstandingAmount: string;
    agingBucket: string;
    daysOverdue: number;
    requiresComment: boolean;
    commentText: string | null;
    riskFlag: string;
    reviewed: boolean;
  }[] = [];

  if (recon) {
    try {
      invoices = await db
        .select({
          id: arInvoiceSnapshots.id,
          xeroInvoiceId: arInvoiceSnapshots.xeroInvoiceId,
          invoiceNumber: arInvoiceSnapshots.invoiceNumber,
          contactName: arInvoiceSnapshots.contactName,
          invoiceDate: arInvoiceSnapshots.invoiceDate,
          dueDate: arInvoiceSnapshots.dueDate,
          originalAmount: arInvoiceSnapshots.originalAmount,
          outstandingAmount: arInvoiceSnapshots.outstandingAmount,
          agingBucket: arInvoiceSnapshots.agingBucket,
          daysOverdue: arInvoiceSnapshots.daysOverdue,
          requiresComment: arInvoiceSnapshots.requiresComment,
          commentText: arInvoiceSnapshots.commentText,
          riskFlag: arInvoiceSnapshots.riskFlag,
          reviewed: arInvoiceSnapshots.reviewed,
        })
        .from(arInvoiceSnapshots)
        .where(eq(arInvoiceSnapshots.reconciliationId, recon.id))
        .orderBy(arInvoiceSnapshots.daysOverdue);
    } catch {
      // Table may not exist yet
    }
  }

  return {
    recon,
    invoices,
    glBalance: parseFloat(account.balance),
    monthEndDate: meDate,
    periodYear: period.periodYear,
    periodMonth: period.periodMonth,
    clientId: period.clientId,
    periodId: period.id,
  };
}

// ------------------------------------------------------------------
// Fetch aged receivables from Xero and create/update the snapshot
// ------------------------------------------------------------------
export async function fetchAgedReceivables(accountId: string) {
  const session = await requireRole("junior");

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

  const meDate = monthEndDate(period.periodYear, period.periodMonth);
  const glBalance = parseFloat(account.balance);

  try {
    // Xero's AgedReceivablesByContact report doesn't reliably give per-invoice
    // historical "as at" data. Instead we pull all AUTHORISED invoices with
    // AmountDue > 0 and filter by date to reconstruct the aged debtors listing
    // as at month end.
    //
    // Endpoints used:
    //   GET /Invoices?where=Type=="ACCREC" AND Status=="AUTHORISED"
    //       AND Date<=DateTime(y,m,d)
    //       AND AmountDue>0
    //
    // Limitation: Xero's Invoices endpoint returns current AmountDue, not
    // the historical amount due as at month end. For invoices partially paid
    // between month end and now, the outstanding figure may differ. This is
    // documented and the user should verify against the Xero aged receivables
    // report run as at the month end date.

    const y = period.periodYear;
    const m = period.periodMonth;
    const lastDay = new Date(y, m, 0).getDate();

    // Fetch all unpaid AR invoices dated on or before month end
    const dateFilter = encodeURIComponent(
      `Type=="ACCREC" && Status=="AUTHORISED" && Date<=DateTime(${y},${m},${lastDay}) && AmountDue>0`
    );

    const resp = await xeroGet<{ Invoices: XeroInvoice[] }>(
      connection.id,
      connection.xeroTenantId,
      `/Invoices?where=${dateFilter}&order=DueDate`
    );

    const xeroInvoices = (resp.Invoices || []).filter(
      (inv) => inv.Status !== "DELETED" && inv.Status !== "VOIDED"
    );

    // Calculate aging and totals
    const invoiceRows = xeroInvoices.map((inv) => {
      const invoiceDate = parseXeroDate(inv.Date);
      const dueDate = parseXeroDate(inv.DueDate);
      const { bucket, daysOverdue, requiresComment } = calculateAging(
        dueDate,
        meDate
      );

      return {
        xeroInvoiceId: inv.InvoiceID,
        invoiceNumber: inv.InvoiceNumber || null,
        contactName: inv.Contact?.Name || "Unknown",
        invoiceDate,
        dueDate,
        originalAmount: String(inv.Total),
        outstandingAmount: String(inv.AmountDue),
        agingBucket: bucket as AgingBucket,
        daysOverdue,
        requiresComment,
      };
    });

    const agedTotal = invoiceRows.reduce(
      (sum, inv) => sum + parseFloat(inv.outstandingAmount),
      0
    );
    const variance = Math.round((glBalance - agedTotal) * 100) / 100;

    // Upsert reconciliation record
    const [existing] = await db
      .select()
      .from(arReconciliations)
      .where(eq(arReconciliations.reconAccountId, accountId))
      .limit(1);

    let reconId: string;

    if (existing) {
      reconId = existing.id;

      await db
        .update(arReconciliations)
        .set({
          monthEndDate: meDate,
          ledgerBalance: String(glBalance),
          agedReportTotal: String(agedTotal),
          variance: String(variance),
          status: "draft",
          signedOffBy: null,
          signedOffAt: null,
          updatedAt: new Date(),
        })
        .where(eq(arReconciliations.id, existing.id));

      // Delete old snapshots (cascade would handle it, but explicit is clearer)
      await db
        .delete(arInvoiceSnapshots)
        .where(eq(arInvoiceSnapshots.reconciliationId, existing.id));
    } else {
      const [newRecon] = await db
        .insert(arReconciliations)
        .values({
          reconAccountId: accountId,
          monthEndDate: meDate,
          ledgerBalance: String(glBalance),
          agedReportTotal: String(agedTotal),
          variance: String(variance),
          status: "draft",
        })
        .returning();

      reconId = newRecon.id;
    }

    // Insert invoice snapshots
    if (invoiceRows.length > 0) {
      await db.insert(arInvoiceSnapshots).values(
        invoiceRows.map((inv) => ({
          reconciliationId: reconId,
          ...inv,
        }))
      );
    }

    revalidatePath(
      `/clients/${period.clientId}/periods/${period.id}/accounts/${accountId}`
    );

    return {
      success: true,
      invoiceCount: invoiceRows.length,
      agedTotal,
      variance,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: `Failed to fetch from Xero: ${message}` };
  }
}

// ------------------------------------------------------------------
// Update comment on an invoice snapshot
// ------------------------------------------------------------------
export async function updateInvoiceComment(
  snapshotId: string,
  commentText: string
) {
  const session = await requireRole("junior");

  const [snapshot] = await db
    .select()
    .from(arInvoiceSnapshots)
    .where(eq(arInvoiceSnapshots.id, snapshotId))
    .limit(1);

  if (!snapshot) return { error: "Invoice snapshot not found" };

  const previousComment = snapshot.commentText || "";

  await db
    .update(arInvoiceSnapshots)
    .set({
      commentText: commentText.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(arInvoiceSnapshots.id, snapshotId));

  // Audit log
  await db.insert(arAuditLog).values({
    userId: session.user.id,
    invoiceSnapshotId: snapshotId,
    changeType: "comment_updated",
    previousValue: previousComment,
    newValue: commentText.trim(),
  });

  // Revalidate
  await revalidateFromSnapshot(snapshot.reconciliationId);

  return { success: true };
}

// ------------------------------------------------------------------
// Update risk flag on an invoice snapshot
// ------------------------------------------------------------------
export async function updateInvoiceRiskFlag(
  snapshotId: string,
  riskFlag: RiskFlag
) {
  const session = await requireRole("junior");

  const [snapshot] = await db
    .select()
    .from(arInvoiceSnapshots)
    .where(eq(arInvoiceSnapshots.id, snapshotId))
    .limit(1);

  if (!snapshot) return { error: "Invoice snapshot not found" };

  const previousFlag = snapshot.riskFlag;

  await db
    .update(arInvoiceSnapshots)
    .set({
      riskFlag,
      updatedAt: new Date(),
    })
    .where(eq(arInvoiceSnapshots.id, snapshotId));

  await db.insert(arAuditLog).values({
    userId: session.user.id,
    invoiceSnapshotId: snapshotId,
    changeType: "risk_flag_changed",
    previousValue: previousFlag,
    newValue: riskFlag,
  });

  await revalidateFromSnapshot(snapshot.reconciliationId);

  return { success: true };
}

// ------------------------------------------------------------------
// Mark invoice as reviewed
// ------------------------------------------------------------------
export async function toggleInvoiceReviewed(
  snapshotId: string,
  reviewed: boolean
) {
  const session = await requireRole("junior");

  const [snapshot] = await db
    .select()
    .from(arInvoiceSnapshots)
    .where(eq(arInvoiceSnapshots.id, snapshotId))
    .limit(1);

  if (!snapshot) return { error: "Invoice snapshot not found" };

  await db
    .update(arInvoiceSnapshots)
    .set({
      reviewed,
      updatedAt: new Date(),
    })
    .where(eq(arInvoiceSnapshots.id, snapshotId));

  await db.insert(arAuditLog).values({
    userId: session.user.id,
    invoiceSnapshotId: snapshotId,
    changeType: "reviewed_toggled",
    previousValue: String(snapshot.reviewed),
    newValue: String(reviewed),
  });

  await revalidateFromSnapshot(snapshot.reconciliationId);

  return { success: true };
}

// ------------------------------------------------------------------
// Bulk mark bucket as reviewed
// ------------------------------------------------------------------
export async function bulkMarkBucketReviewed(
  reconciliationId: string,
  bucket: AgingBucket
) {
  const session = await requireRole("junior");

  const snapshots = await db
    .select()
    .from(arInvoiceSnapshots)
    .where(eq(arInvoiceSnapshots.reconciliationId, reconciliationId));

  const matching = snapshots.filter(
    (s) => s.agingBucket === bucket && !s.reviewed
  );

  for (const snap of matching) {
    await db
      .update(arInvoiceSnapshots)
      .set({ reviewed: true, updatedAt: new Date() })
      .where(eq(arInvoiceSnapshots.id, snap.id));

    await db.insert(arAuditLog).values({
      userId: session.user.id,
      invoiceSnapshotId: snap.id,
      changeType: "reviewed_toggled",
      previousValue: "false",
      newValue: "true",
    });
  }

  await revalidateFromSnapshot(reconciliationId);

  return { success: true, count: matching.length };
}

// ------------------------------------------------------------------
// Mark reconciliation as complete (with validation)
// ------------------------------------------------------------------
export async function markARReconComplete(reconciliationId: string) {
  const session = await requireRole("junior");

  const [recon] = await db
    .select()
    .from(arReconciliations)
    .where(eq(arReconciliations.id, reconciliationId))
    .limit(1);

  if (!recon) return { error: "Reconciliation not found" };

  // Validation: variance must be zero
  const variance = parseFloat(recon.variance || "0");
  if (Math.abs(variance) >= 0.005) {
    return {
      error: `Cannot mark complete: variance of ${variance.toFixed(2)} exists between ledger balance and aged debtors total`,
    };
  }

  // Validation: all 90+ invoices must have comments
  const snapshots = await db
    .select()
    .from(arInvoiceSnapshots)
    .where(eq(arInvoiceSnapshots.reconciliationId, reconciliationId));

  const uncommented90Plus = snapshots.filter(
    (s) => s.agingBucket === "90_plus" && !s.commentText?.trim()
  );

  if (uncommented90Plus.length > 0) {
    return {
      error: `Cannot mark complete: ${uncommented90Plus.length} invoice(s) over 90 days require comments`,
    };
  }

  await db
    .update(arReconciliations)
    .set({
      status: "complete",
      signedOffBy: session.user.id,
      signedOffAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(arReconciliations.id, reconciliationId));

  await revalidateFromSnapshot(reconciliationId);

  return { success: true };
}

// ------------------------------------------------------------------
// Reopen reconciliation (set back to draft)
// ------------------------------------------------------------------
export async function reopenARRecon(reconciliationId: string) {
  await requireRole("manager");

  await db
    .update(arReconciliations)
    .set({
      status: "draft",
      signedOffBy: null,
      signedOffAt: null,
      updatedAt: new Date(),
    })
    .where(eq(arReconciliations.id, reconciliationId));

  await revalidateFromSnapshot(reconciliationId);

  return { success: true };
}

// ------------------------------------------------------------------
// Internal: revalidate path from a reconciliation ID
// ------------------------------------------------------------------
async function revalidateFromSnapshot(reconciliationId: string) {
  const [recon] = await db
    .select()
    .from(arReconciliations)
    .where(eq(arReconciliations.id, reconciliationId))
    .limit(1);

  if (!recon) return;

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, recon.reconAccountId))
    .limit(1);

  if (!account) return;

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
