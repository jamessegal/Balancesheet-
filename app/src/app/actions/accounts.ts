"use server";

import { db } from "@/lib/db";
import { xeroConnections } from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { xeroGet } from "@/lib/xero/client";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

interface XeroAccount {
  AccountID: string;
  Code: string;
  Name: string;
  Type: string;
  BankAccountNumber?: string;
  Status: string;
  Description?: string;
  Class: string;
  SystemAccount?: string;
  EnablePaymentsToAccount?: boolean;
  ShowInExpenseClaims?: boolean;
  BankAccountType?: string;
  ReportingCode?: string;
  ReportingCodeName?: string;
}

interface XeroAccountsResponse {
  Accounts: XeroAccount[];
}

export type ChartOfAccounts = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  class: string;
  status: string;
  reportingCode?: string;
}[];

export async function fetchChartOfAccounts(
  clientId: string
): Promise<{ accounts: ChartOfAccounts } | { error: string }> {
  await requireRole("manager");

  const [connection] = await db
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.clientId, clientId))
    .limit(1);

  if (!connection) {
    return { error: "No Xero connection found for this client" };
  }

  if (connection.status !== "active") {
    return { error: `Xero connection is ${connection.status}. Please reconnect.` };
  }

  try {
    const data = await xeroGet<XeroAccountsResponse>(
      connection.id,
      connection.xeroTenantId,
      "/Accounts"
    );

    const accounts: ChartOfAccounts = data.Accounts
      .filter((a) => a.Status === "ACTIVE")
      .map((a) => ({
        accountId: a.AccountID,
        code: a.Code || "",
        name: a.Name,
        type: a.Type,
        class: a.Class,
        status: a.Status,
        reportingCode: a.ReportingCode,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    // Update last synced timestamp
    await db
      .update(xeroConnections)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(xeroConnections.id, connection.id));

    revalidatePath(`/clients/${clientId}`);

    return { accounts };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: `Failed to fetch accounts: ${message}` };
  }
}
