"use server";

import { db } from "@/lib/db";
import {
  accountReconConfig,
  reconciliationAccounts,
  reconciliationPeriods,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// ------------------------------------------------------------------
// Get all recon configs for a client
// ------------------------------------------------------------------
export async function getReconConfigs(clientId: string) {
  await requireRole("junior");

  return db
    .select()
    .from(accountReconConfig)
    .where(eq(accountReconConfig.clientId, clientId))
    .orderBy(accountReconConfig.accountName);
}

// ------------------------------------------------------------------
// Get recon config for a specific account
// ------------------------------------------------------------------
export async function getReconConfigForAccount(
  clientId: string,
  xeroAccountId: string
) {
  await requireRole("junior");

  const [config] = await db
    .select()
    .from(accountReconConfig)
    .where(
      and(
        eq(accountReconConfig.clientId, clientId),
        eq(accountReconConfig.xeroAccountId, xeroAccountId)
      )
    )
    .limit(1);

  return config ?? null;
}

// ------------------------------------------------------------------
// Set recon module for an account (upsert)
// ------------------------------------------------------------------
export async function setReconModule(
  clientId: string,
  xeroAccountId: string,
  accountName: string,
  reconModule: string
) {
  await requireRole("manager");

  const [existing] = await db
    .select()
    .from(accountReconConfig)
    .where(
      and(
        eq(accountReconConfig.clientId, clientId),
        eq(accountReconConfig.xeroAccountId, xeroAccountId)
      )
    )
    .limit(1);

  if (existing) {
    await db
      .update(accountReconConfig)
      .set({ reconModule, updatedAt: new Date() })
      .where(eq(accountReconConfig.id, existing.id));
  } else {
    await db.insert(accountReconConfig).values({
      clientId,
      xeroAccountId,
      accountName,
      reconModule,
    });
  }

  revalidatePath(`/clients/${clientId}`);
  return { success: true };
}

// ------------------------------------------------------------------
// Bulk set recon modules from form data
// ------------------------------------------------------------------
export async function bulkSetReconModules(formData: FormData) {
  await requireRole("manager");

  const clientId = formData.get("clientId") as string;
  if (!clientId) return { error: "Client ID required" };

  // Form sends entries like "module_<xeroAccountId>=<reconModule>"
  const updates: { xeroAccountId: string; accountName: string; reconModule: string }[] = [];

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("module_")) {
      const xeroAccountId = key.slice(7); // remove "module_" prefix
      const accountName = formData.get(`name_${xeroAccountId}`) as string || "";
      updates.push({
        xeroAccountId,
        accountName,
        reconModule: value as string,
      });
    }
  }

  for (const update of updates) {
    const [existing] = await db
      .select()
      .from(accountReconConfig)
      .where(
        and(
          eq(accountReconConfig.clientId, clientId),
          eq(accountReconConfig.xeroAccountId, update.xeroAccountId)
        )
      )
      .limit(1);

    if (existing) {
      if (existing.reconModule !== update.reconModule) {
        await db
          .update(accountReconConfig)
          .set({ reconModule: update.reconModule, updatedAt: new Date() })
          .where(eq(accountReconConfig.id, existing.id));
      }
    } else {
      await db.insert(accountReconConfig).values({
        clientId,
        xeroAccountId: update.xeroAccountId,
        accountName: update.accountName,
        reconModule: update.reconModule,
      });
    }
  }

  revalidatePath(`/clients/${clientId}`);
  return { success: true };
}

// ------------------------------------------------------------------
// Get unmapped accounts for a client (accounts in BS but not in config)
// ------------------------------------------------------------------
export async function getUnmappedAccounts(clientId: string) {
  await requireRole("junior");

  // Get all unique accounts across all periods for this client
  const allAccounts = await db
    .select({
      xeroAccountId: reconciliationAccounts.xeroAccountId,
      accountName: reconciliationAccounts.accountName,
      accountType: reconciliationAccounts.accountType,
    })
    .from(reconciliationAccounts)
    .innerJoin(
      reconciliationPeriods,
      eq(reconciliationAccounts.periodId, reconciliationPeriods.id)
    )
    .where(eq(reconciliationPeriods.clientId, clientId));

  // Deduplicate by xeroAccountId
  const uniqueAccounts = new Map<
    string,
    { xeroAccountId: string; accountName: string; accountType: string }
  >();
  for (const a of allAccounts) {
    if (!uniqueAccounts.has(a.xeroAccountId)) {
      uniqueAccounts.set(a.xeroAccountId, a);
    }
  }

  // Get existing configs
  const configs = await db
    .select()
    .from(accountReconConfig)
    .where(eq(accountReconConfig.clientId, clientId));

  const configuredIds = new Set(
    configs.map((c) => c.xeroAccountId).filter(Boolean)
  );

  // Return accounts not yet configured
  const unmapped = Array.from(uniqueAccounts.values()).filter(
    (a) => !configuredIds.has(a.xeroAccountId)
  );

  return unmapped;
}
