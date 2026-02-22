import { db } from "@/lib/db";
import {
  clients,
  users,
  reconciliationPeriods,
  glUploads,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasMinRole } from "@/lib/authorization";
import { getXeroConnection, disconnectXero } from "@/app/actions/xero";
import { XeroAccountsPanel } from "@/components/xero-accounts";
import { GLUploadForm } from "@/components/gl-upload";
import { ReconConfigPanel } from "@/components/recon-config";
import { OpenPeriodForm } from "@/components/open-period-form";
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

  // Latest GL upload info
  let latestUpload: {
    fileName: string;
    rowCount: number;
    accountCount: number;
    dateFrom: string | null;
    dateTo: string | null;
    createdAt: Date;
  } | null = null;
  try {
    const [upload] = await db
      .select({
        fileName: glUploads.fileName,
        rowCount: glUploads.rowCount,
        accountCount: glUploads.accountCount,
        dateFrom: glUploads.dateFrom,
        dateTo: glUploads.dateTo,
        createdAt: glUploads.createdAt,
      })
      .from(glUploads)
      .where(eq(glUploads.clientId, clientId))
      .orderBy(desc(glUploads.createdAt))
      .limit(1);
    latestUpload = upload ?? null;
  } catch {
    // Table doesn't exist yet
  }

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

      {/* General Ledger Upload */}
      {isManager && (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium">General Ledger Data</h2>
              <p className="mt-1 text-sm text-gray-500">
                Upload a Xero General Ledger (Detailed) export for historical transaction data.
              </p>
            </div>
          </div>
          {latestUpload && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-center gap-4 text-sm">
                <span className="inline-flex items-center gap-1.5 text-green-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                  Loaded
                </span>
                <span className="text-gray-600">
                  {latestUpload.fileName}
                </span>
                <span className="text-gray-400">
                  {latestUpload.rowCount.toLocaleString()} transactions
                </span>
                <span className="text-gray-400">
                  {latestUpload.accountCount} accounts
                </span>
                {latestUpload.dateFrom && latestUpload.dateTo && (
                  <span className="text-gray-400">
                    {latestUpload.dateFrom} to {latestUpload.dateTo}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="mt-4">
            <GLUploadForm clientId={clientId} />
          </div>
        </div>
      )}

      {/* Reconciliation Config — map accounts to recon modules */}
      {isManager && <ReconConfigPanel clientId={clientId} />}

      {/* Chart of Accounts — only show when Xero is connected */}
      {xeroConnection?.status === "active" && isManager && (
        <XeroAccountsPanel clientId={clientId} />
      )}

      {/* Reconciliation Periods */}
      {xeroConnection?.status === "active" && (
        <PeriodsSection clientId={clientId} isManager={isManager} />
      )}
    </div>
  );
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-700" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700" },
  ready_for_review: { label: "Ready for Review", className: "bg-yellow-100 text-yellow-700" },
  approved: { label: "Approved", className: "bg-green-100 text-green-700" },
  reopened: { label: "Reopened", className: "bg-red-100 text-red-700" },
};

async function PeriodsSection({
  clientId,
  isManager,
}: {
  clientId: string;
  isManager: boolean;
}) {
  const periods = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.clientId, clientId))
    .orderBy(
      desc(reconciliationPeriods.periodYear),
      desc(reconciliationPeriods.periodMonth)
    );

  // Build list of openable months (current + 12 months back), excluding already-opened
  const now = new Date();
  const existingPeriods = new Set(
    periods.map((p) => `${p.periodYear}-${p.periodMonth}`)
  );
  const availableMonths: { year: number; month: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    if (!existingPeriods.has(`${y}-${m}`)) {
      availableMonths.push({ year: y, month: m });
    }
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Reconciliation Periods</h2>
        {isManager && availableMonths.length > 0 && (
          <OpenPeriodForm clientId={clientId} availableMonths={availableMonths} />
        )}
      </div>

      {periods.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-8 text-center">
          <p className="text-sm text-gray-500">
            No reconciliation periods yet. Open a period to get started.
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Period
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Opened
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {periods.map((period) => {
                const badge = STATUS_BADGES[period.status] || STATUS_BADGES.draft;
                return (
                  <tr key={period.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                      <Link
                        href={`/clients/${clientId}/periods/${period.id}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        {MONTH_NAMES[period.periodMonth - 1]} {period.periodYear}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                      {new Date(period.createdAt).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                      <Link
                        href={`/clients/${clientId}/periods/${period.id}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
