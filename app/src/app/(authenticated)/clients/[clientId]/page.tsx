import { db } from "@/lib/db";
import { clients, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasMinRole } from "@/lib/authorization";
import { getXeroConnection, disconnectXero } from "@/app/actions/xero";
import { XeroAccountsPanel } from "@/components/xero-accounts";
import Link from "next/link";

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const { clientId } = await params;
  const query = await searchParams;
  const session = await auth();
  const isManager = hasMinRole(
    session!.user.role as "admin" | "manager" | "junior",
    "manager"
  );

  const [client] = await db
    .select({
      id: clients.id,
      name: clients.name,
      code: clients.code,
      contactEmail: clients.contactEmail,
      contactName: clients.contactName,
      notes: clients.notes,
      createdAt: clients.createdAt,
      createdByName: users.name,
    })
    .from(clients)
    .leftJoin(users, eq(clients.createdBy, users.id))
    .where(eq(clients.id, clientId))
    .limit(1);

  if (!client) {
    notFound();
  }

  const xeroConnection = await getXeroConnection(clientId);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/clients"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          &larr; Back to Clients
        </Link>
      </div>

      {/* Success/error banners */}
      {query.xero === "connected" && (
        <div className="mb-4 rounded-md bg-green-50 border border-green-200 p-4">
          <p className="text-sm text-green-800">
            Xero connected successfully!
          </p>
        </div>
      )}
      {query.error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 p-4">
          <p className="text-sm text-red-800">
            Error: {query.error.replace(/_/g, " ")}
          </p>
        </div>
      )}

      {/* Client header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{client.name}</h1>
          <p className="mt-1 text-sm text-gray-500">
            Code: {client.code} &middot; Created by {client.createdByName}
          </p>
        </div>
      </div>

      {/* Client details */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-medium">Details</h2>
          <dl className="mt-4 space-y-3">
            {client.contactName && (
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  Contact Name
                </dt>
                <dd className="text-sm text-gray-900">{client.contactName}</dd>
              </div>
            )}
            {client.contactEmail && (
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  Contact Email
                </dt>
                <dd className="text-sm text-gray-900">
                  {client.contactEmail}
                </dd>
              </div>
            )}
            {client.notes && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Notes</dt>
                <dd className="text-sm text-gray-900">{client.notes}</dd>
              </div>
            )}
            <div>
              <dt className="text-sm font-medium text-gray-500">Created</dt>
              <dd className="text-sm text-gray-900">
                {new Date(client.createdAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        </div>

        {/* Xero connection card */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-medium">Xero Connection</h2>

          {xeroConnection ? (
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${
                    xeroConnection.status === "active"
                      ? "bg-green-500"
                      : xeroConnection.status === "expired"
                        ? "bg-yellow-500"
                        : "bg-red-500"
                  }`}
                />
                <span className="text-sm font-medium capitalize">
                  {xeroConnection.status}
                </span>
              </div>
              <dl className="mt-3 space-y-2">
                {xeroConnection.xeroTenantName && (
                  <div>
                    <dt className="text-sm font-medium text-gray-500">
                      Organisation
                    </dt>
                    <dd className="text-sm text-gray-900">
                      {xeroConnection.xeroTenantName}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-sm font-medium text-gray-500">
                    Connected
                  </dt>
                  <dd className="text-sm text-gray-900">
                    {new Date(xeroConnection.connectedAt).toLocaleDateString()}
                  </dd>
                </div>
                {xeroConnection.lastSyncedAt && (
                  <div>
                    <dt className="text-sm font-medium text-gray-500">
                      Last Synced
                    </dt>
                    <dd className="text-sm text-gray-900">
                      {new Date(
                        xeroConnection.lastSyncedAt
                      ).toLocaleString()}
                    </dd>
                  </div>
                )}
              </dl>

              {isManager && (
                <div className="mt-4 flex gap-2">
                  {xeroConnection.status !== "active" && (
                    <a
                      href={`/api/xero/connect?clientId=${clientId}`}
                      className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Reconnect Xero
                    </a>
                  )}
                  <form
                    action={async () => {
                      "use server";
                      await disconnectXero(clientId);
                    }}
                  >
                    <button
                      type="submit"
                      className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      Disconnect
                    </button>
                  </form>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-4">
              <p className="text-sm text-gray-500">
                No Xero organisation connected to this client.
              </p>
              {isManager && (
                <a
                  href={`/api/xero/connect?clientId=${clientId}`}
                  className="mt-3 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Connect Xero
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Chart of Accounts — only show when Xero is connected */}
      {xeroConnection?.status === "active" && isManager && (
        <XeroAccountsPanel clientId={clientId} />
      )}
    </div>
  );
}
