import Link from "next/link";
import { db } from "@/lib/db";
import { clients, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { hasMinRole } from "@/lib/authorization";

export default async function ClientsPage() {
  const session = await auth();
  const canCreate = hasMinRole(
    session!.user.role as "admin" | "manager" | "junior",
    "manager"
  );

  const allClients = await db
    .select({
      id: clients.id,
      name: clients.name,
      code: clients.code,
      contactEmail: clients.contactEmail,
      contactName: clients.contactName,
      createdAt: clients.createdAt,
      createdByName: users.name,
    })
    .from(clients)
    .leftJoin(users, eq(clients.createdBy, users.id))
    .orderBy(clients.name);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage your client list
          </p>
        </div>
        {canCreate && (
          <Link
            href="/clients/new"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add Client
          </Link>
        )}
      </div>

      {allClients.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-sm text-gray-500">No clients yet.</p>
          {canCreate && (
            <Link
              href="/clients/new"
              className="mt-2 inline-block text-sm text-blue-600 hover:text-blue-700"
            >
              Add your first client
            </Link>
          )}
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Code
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Contact
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Created By
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {allClients.map((client) => (
                <tr key={client.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                    {client.code}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-900">
                    {client.name}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    {client.contactName && (
                      <span>{client.contactName}</span>
                    )}
                    {client.contactEmail && (
                      <span className="block text-xs text-gray-400">
                        {client.contactEmail}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    {client.createdByName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
