import { db } from "@/lib/db";
import {
  clients,
  reconciliationPeriods,
  reconciliationAccounts,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasMinRole } from "@/lib/authorization";
import Link from "next/link";
import { PullBalanceSheetButton } from "@/components/pull-balance-sheet";

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

export default async function PeriodDetailPage({
  params,
}: {
  params: Promise<{ clientId: string; periodId: string }>;
}) {
  const { clientId, periodId } = await params;
  const session = await auth();
  const isManager = hasMinRole(
    session!.user.role as "admin" | "manager" | "junior",
    "manager"
  );

  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (!client) notFound();

  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, periodId))
    .limit(1);

  if (!period || period.clientId !== clientId) notFound();

  const accounts = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.periodId, periodId))
    .orderBy(reconciliationAccounts.accountCode);

  const periodLabel = `${MONTH_NAMES[period.periodMonth - 1]} ${period.periodYear}`;
  const periodBadge = STATUS_BADGES[period.status] || STATUS_BADGES.draft;

  // Summary stats
  const totalAccounts = accounts.length;
  const draftCount = accounts.filter((a) => a.status === "draft").length;
  const inProgressCount = accounts.filter((a) => a.status === "in_progress").length;
  const reviewCount = accounts.filter((a) => a.status === "ready_for_review").length;
  const approvedCount = accounts.filter((a) => a.status === "approved").length;

  return (
    <div>
      {/* Breadcrumbs */}
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500">
        <Link href="/clients" className="hover:text-gray-700">
          Clients
        </Link>
        <span>/</span>
        <Link href={`/clients/${clientId}`} className="hover:text-gray-700">
          {client.name}
        </Link>
        <span>/</span>
        <span className="text-gray-900">{periodLabel}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{periodLabel}</h1>
          <div className="mt-2 flex items-center gap-3">
            <span
              className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${periodBadge.className}`}
            >
              {periodBadge.label}
            </span>
            <span className="text-sm text-gray-500">
              {client.name} ({client.code})
            </span>
          </div>
        </div>
        {isManager && (
          <PullBalanceSheetButton periodId={periodId} />
        )}
      </div>

      {/* Summary cards */}
      {totalAccounts > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard label="Draft" count={draftCount} color="gray" />
          <SummaryCard label="In Progress" count={inProgressCount} color="blue" />
          <SummaryCard label="Review" count={reviewCount} color="yellow" />
          <SummaryCard label="Approved" count={approvedCount} color="green" />
        </div>
      )}

      {/* Account list */}
      {accounts.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-sm text-gray-500">
            No accounts yet. Pull the balance sheet from Xero to populate accounts.
          </p>
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
                  Account
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Type
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Balance
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Prior Balance
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Movement
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {accounts.map((account) => {
                const balance = parseFloat(account.balance);
                const prior = account.priorBalance
                  ? parseFloat(account.priorBalance)
                  : null;
                const movement = prior !== null ? balance - prior : null;
                const badge =
                  STATUS_BADGES[account.status] || STATUS_BADGES.draft;

                return (
                  <tr key={account.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-mono text-gray-500">
                      {account.accountCode || "-"}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                      {account.accountName}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                      {account.accountType}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-mono text-gray-900">
                      {formatCurrency(balance)}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-mono text-gray-500">
                      {prior !== null ? formatCurrency(prior) : "-"}
                    </td>
                    <td
                      className={`whitespace-nowrap px-6 py-4 text-right text-sm font-mono ${
                        movement !== null && movement !== 0
                          ? movement > 0
                            ? "text-green-600"
                            : "text-red-600"
                          : "text-gray-400"
                      }`}
                    >
                      {movement !== null ? formatCurrency(movement) : "-"}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* Totals row */}
            <tfoot className="bg-gray-50">
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-900" colSpan={3}>
                  Total ({totalAccounts} accounts)
                </td>
                <td className="px-6 py-3 text-right text-sm font-mono font-medium text-gray-900">
                  {formatCurrency(
                    accounts.reduce((sum, a) => sum + parseFloat(a.balance), 0)
                  )}
                </td>
                <td className="px-6 py-3 text-right text-sm font-mono text-gray-500">
                  {accounts.some((a) => a.priorBalance !== null)
                    ? formatCurrency(
                        accounts.reduce(
                          (sum, a) =>
                            sum + (a.priorBalance ? parseFloat(a.priorBalance) : 0),
                          0
                        )
                      )
                    : "-"}
                </td>
                <td className="px-6 py-3" />
                <td className="px-6 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: "gray" | "blue" | "yellow" | "green";
}) {
  const colors = {
    gray: "border-gray-200 bg-gray-50",
    blue: "border-blue-200 bg-blue-50",
    yellow: "border-yellow-200 bg-yellow-50",
    green: "border-green-200 bg-green-50",
  };

  return (
    <div className={`rounded-lg border p-4 ${colors[color]}`}>
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{count}</p>
    </div>
  );
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
  }).format(amount);
}
