"use server";

import { db } from "@/lib/db";
import { xeroConnections } from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function disconnectXero(clientId: string) {
  await requireRole("manager");

  await db
    .delete(xeroConnections)
    .where(eq(xeroConnections.clientId, clientId));

  revalidatePath(`/clients/${clientId}`);
}

export async function getXeroConnection(clientId: string) {
  const [connection] = await db
    .select({
      id: xeroConnections.id,
      xeroTenantId: xeroConnections.xeroTenantId,
      xeroTenantName: xeroConnections.xeroTenantName,
      tokenExpiresAt: xeroConnections.tokenExpiresAt,
      connectedAt: xeroConnections.connectedAt,
      lastSyncedAt: xeroConnections.lastSyncedAt,
      status: xeroConnections.status,
    })
    .from(xeroConnections)
    .where(eq(xeroConnections.clientId, clientId))
    .limit(1);

  return connection ?? null;
}
