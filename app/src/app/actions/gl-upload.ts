"use server";

import { db } from "@/lib/db";
import { clients, glUploads, glTransactions } from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { parseGLReport } from "@/lib/gl-parser";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

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
