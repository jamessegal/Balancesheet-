import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { clients, users } from "@/lib/db/schema";
import { count } from "drizzle-orm";
import Link from "next/link";

export default async function DashboardPage() {
  const session = await auth();
  const [clientCount] = await db.select({ count: count() }).from(clients);
  const [userCount] = await db.select({ count: count() }).from(users);

  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">
        Welcome back, {session?.user?.name}
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <p className="text-sm font-medium text-gray-500">Total Clients</p>
          <p className="mt-2 text-3xl font-semibold">{clientCount.count}</p>
          <Link
            href="/clients"
            className="mt-4 inline-block text-sm text-blue-600 hover:text-blue-700"
          >
            View all clients
          </Link>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <p className="text-sm font-medium text-gray-500">Team Members</p>
          <p className="mt-2 text-3xl font-semibold">{userCount.count}</p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <p className="text-sm font-medium text-gray-500">Your Role</p>
          <p className="mt-2 text-3xl font-semibold capitalize">
            {session?.user?.role}
          </p>
        </div>
      </div>
    </div>
  );
}
