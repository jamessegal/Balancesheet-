"use server";

import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

export async function createClient(formData: FormData) {
  const session = await requireRole("manager");

  const name = (formData.get("name") as string)?.trim();
  const code = (formData.get("code") as string)?.trim().toUpperCase();
  const contactEmail = (formData.get("contactEmail") as string)?.trim() || null;
  const contactName = (formData.get("contactName") as string)?.trim() || null;
  const notes = (formData.get("notes") as string)?.trim() || null;

  if (!name || !code) {
    return { error: "Name and code are required" };
  }

  // Check for duplicate code
  const [existing] = await db
    .select()
    .from(clients)
    .where(eq(clients.code, code))
    .limit(1);

  if (existing) {
    return { error: `A client with code "${code}" already exists` };
  }

  await db.insert(clients).values({
    name,
    code,
    contactEmail,
    contactName,
    notes,
    createdBy: session.user.id,
  });

  revalidatePath("/clients");
  redirect("/clients");
}

export async function getClients() {
  await requireRole("junior");
  return db.select().from(clients).orderBy(clients.name);
}
