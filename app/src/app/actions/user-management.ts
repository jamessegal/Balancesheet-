"use server";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireRole } from "@/lib/authorization";
import { eq } from "drizzle-orm";
import { hash } from "bcryptjs";
import { revalidatePath } from "next/cache";

export async function listUsers() {
  await requireRole("admin");

  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.name);
}

export async function createUser(formData: FormData) {
  await requireRole("admin");

  const name = (formData.get("name") as string)?.trim();
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const role = formData.get("role") as "admin" | "manager" | "junior";
  const password = formData.get("password") as string;

  if (!name || !email || !role || !password) {
    return { error: "All fields are required" };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters" };
  }

  if (!["admin", "manager", "junior"].includes(role)) {
    return { error: "Invalid role" };
  }

  // Check for duplicate email
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return { error: "A user with this email already exists" };
  }

  const passwordHash = await hash(password, 12);

  await db.insert(users).values({
    name,
    email,
    role,
    passwordHash,
  });

  revalidatePath("/admin/users");
  return { success: true };
}

export async function updateUserRole(userId: string, role: "admin" | "manager" | "junior") {
  const session = await requireRole("admin");

  if (!["admin", "manager", "junior"].includes(role)) {
    return { error: "Invalid role" };
  }

  // Prevent admin from demoting themselves
  if (userId === session.user.id) {
    return { error: "You cannot change your own role" };
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return { error: "User not found" };
  }

  await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.id, userId));

  revalidatePath("/admin/users");
  return { success: true };
}

export async function resetUserPassword(userId: string, newPassword: string) {
  const session = await requireRole("admin");

  if (newPassword.length < 8) {
    return { error: "Password must be at least 8 characters" };
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return { error: "User not found" };
  }

  const passwordHash = await hash(newPassword, 12);

  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId));

  revalidatePath("/admin/users");
  return { success: true };
}

export async function deleteUser(userId: string) {
  const session = await requireRole("admin");

  if (userId === session.user.id) {
    return { error: "You cannot delete your own account" };
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return { error: "User not found" };
  }

  // Note: this will fail if user has foreign key references (created clients, etc.)
  // which is actually the desired behavior — don't delete users who have audit trail
  try {
    await db.delete(users).where(eq(users.id, userId));
  } catch {
    return { error: "Cannot delete user — they have associated records. Change their role instead." };
  }

  revalidatePath("/admin/users");
  return { success: true };
}
