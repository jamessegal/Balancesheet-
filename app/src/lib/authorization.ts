import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

type Role = "admin" | "manager" | "junior";

const ROLE_HIERARCHY: Record<Role, number> = {
  admin: 3,
  manager: 2,
  junior: 1,
};

export function hasMinRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

export async function requireAuth() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  return session;
}

export async function requireRole(minimumRole: Role) {
  const session = await requireAuth();
  if (!hasMinRole(session.user.role as Role, minimumRole)) {
    redirect("/dashboard?error=unauthorized");
  }
  return session;
}
