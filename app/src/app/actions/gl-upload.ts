"use server";

import { db } from "@/lib/db";
import { clients, glUploads, glTransactions } from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { parseGLReport } from "@/lib/gl-parser";
import { eq, sql, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Preview what will change when re-uploading a GL report.
 * Returns null if no prior upload exists (first upload).
 */
export async function previewGLReupload(formData: FormData) {
  await requireRole("manager");

  const clientId = formData.get("clientId") as string;
  const file = formData.get("file") as File;

  if (!clientId || !file) {
    return { error: "Client and file are required" };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { error: "File too large (max 50 MB)" };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = parseGLReport(buffer);

    if (result.rows.length === 0) {
      return {
        error:
          "No transactions found in the file. Check it's a Xero General Ledger (Detailed) export.",
      };
    }

    // Check for existing upload
    const [existingUpload] = await db
      .select({
        id: glUploads.id,
        fileName: glUploads.fileName,
        rowCount: glUploads.rowCount,
        accountCount: glUploads.accountCount,
        dateFrom: glUploads.dateFrom,
        dateTo: glUploads.dateTo,
      })
      .from(glUploads)
      .where(eq(glUploads.clientId, clientId))
      .orderBy(desc(glUploads.createdAt))
      .limit(1);

    if (!existingUpload) {
      // No prior upload — no diff needed, proceed directly
      return { isFirstUpload: true };
    }

    // Collect old account-level summaries
    const oldAccountSummary = await db
      .select({
        accountName: glTransactions.accountName,
        txnCount: sql<number>`count(*)::int`,
        totalDebit: sql<string>`coalesce(sum(${glTransactions.debit}::numeric), 0)`,
        totalCredit: sql<string>`coalesce(sum(${glTransactions.credit}::numeric), 0)`,
      })
      .from(glTransactions)
      .where(eq(glTransactions.uploadId, existingUpload.id))
      .groupBy(glTransactions.accountName);

    const oldMap = new Map(
      oldAccountSummary.map((a) => [a.accountName, a])
    );

    // Compute new account-level summaries
    const newAccountMap = new Map<
      string,
      { txnCount: number; totalDebit: number; totalCredit: number }
    >();

    for (const row of result.rows) {
      const entry = newAccountMap.get(row.accountName) || {
        txnCount: 0,
        totalDebit: 0,
        totalCredit: 0,
      };
      entry.txnCount++;
      entry.totalDebit += row.debit;
      entry.totalCredit += row.credit;
      newAccountMap.set(row.accountName, entry);
    }

    // Build diff
    const allAccountNames = new Set([
      ...oldMap.keys(),
      ...newAccountMap.keys(),
    ]);

    const changes: {
      accountName: string;
      changeType: "added" | "removed" | "modified" | "unchanged";
      oldTxnCount: number;
      newTxnCount: number;
      oldTotal: number;
      newTotal: number;
    }[] = [];

    for (const name of allAccountNames) {
      const old = oldMap.get(name);
      const newA = newAccountMap.get(name);

      const oldCount = old?.txnCount || 0;
      const newCount = newA?.txnCount || 0;
      const oldTotal =
        parseFloat(old?.totalDebit || "0") -
        parseFloat(old?.totalCredit || "0");
      const newTotal = (newA?.totalDebit || 0) - (newA?.totalCredit || 0);

      let changeType: "added" | "removed" | "modified" | "unchanged";
      if (!old) changeType = "added";
      else if (!newA) changeType = "removed";
      else if (oldCount !== newCount || Math.abs(oldTotal - newTotal) > 0.01)
        changeType = "modified";
      else changeType = "unchanged";

      if (changeType !== "unchanged") {
        changes.push({
          accountName: name,
          changeType,
          oldTxnCount: oldCount,
          newTxnCount: newCount,
          oldTotal,
          newTotal,
        });
      }
    }

    return {
      isReupload: true,
      priorFileName: existingUpload.fileName,
      priorRowCount: existingUpload.rowCount,
      priorAccountCount: existingUpload.accountCount,
      newRowCount: result.rows.length,
      newAccountCount: result.accountCount,
      newDateFrom: result.dateFrom,
      newDateTo: result.dateTo,
      changes,
      unchangedCount: allAccountNames.size - changes.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: `Failed to parse GL report: ${message}` };
  }
}

export async function uploadGLReport(formData: FormData) {
  const session = await requireRole("manager");

  const clientId = formData.get("clientId") as string;
  const file = formData.get("file") as File;

  if (!clientId || !file) {
    return { error: "Client and file are required" };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { error: "File too large (max 50 MB)" };
  }

  // Verify client exists
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (!client) {
    return { error: "Client not found" };
  }

  try {
    // Parse the Excel file
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = parseGLReport(buffer);

    if (result.rows.length === 0) {
      return {
        error:
          "No transactions found in the file. Check it's a Xero General Ledger (Detailed) export.",
      };
    }

    // Delete previous GL data for this client
    // First find old uploads to cascade delete
    const oldUploads = await db
      .select({ id: glUploads.id })
      .from(glUploads)
      .where(eq(glUploads.clientId, clientId));

    for (const old of oldUploads) {
      await db
        .delete(glTransactions)
        .where(eq(glTransactions.uploadId, old.id));
    }
    await db.delete(glUploads).where(eq(glUploads.clientId, clientId));

    // Create upload record
    const [upload] = await db
      .insert(glUploads)
      .values({
        clientId,
        fileName: file.name,
        uploadedBy: session.user.id,
        rowCount: result.rows.length,
        accountCount: result.accountCount,
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
      })
      .returning({ id: glUploads.id });

    // Bulk insert transactions in batches of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
      const batch = result.rows.slice(i, i + BATCH_SIZE);
      await db.insert(glTransactions).values(
        batch.map((row) => ({
          uploadId: upload.id,
          clientId,
          accountCode: row.accountCode,
          accountName: row.accountName,
          transactionDate: row.date,
          source: row.source || null,
          description: row.description || null,
          reference: row.reference || null,
          contact: row.contact || null,
          debit: String(row.debit),
          credit: String(row.credit),
        }))
      );
    }

    revalidatePath(`/clients/${clientId}`);

    return {
      success: true,
      rowCount: result.rows.length,
      accountCount: result.accountCount,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      accounts: result.accounts,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: `Failed to parse GL report: ${message}` };
  }
}
