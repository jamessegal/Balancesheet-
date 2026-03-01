import { db } from "@/lib/db";
import {
  clients,
  reconciliationPeriods,
  reconciliationAccounts,
  reconciliationItems,
} from "@/lib/db/schema";
import { eq, asc, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasMinRole } from "@/lib/authorization";
import Link from "next/link";
import { PullBalanceSheetButton } from "@/components/pull-balance-sheet";
import { formatCurrency } from "@/lib/format";

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

  // Query reconciliation item totals per account for variance calculation
  let reconTotals: Record<string, number> = {};
  if (accounts.length > 0) {
    try {
      const totals = await db
        .select({
          reconAccountId: reconciliationItems.reconAccountId,
          total: sql<string>`coalesce(sum(${reconciliationItems.amount}::numeric), 0)`,
        })
        .from(reconciliationItems)
        .where(
          sql`${reconciliationItems.reconAccountId} in (${sql.join(
            accounts.map((a) => sql`${a.id}`),
            sql`, `
          )})`
        )
        .groupBy(reconciliationItems.reconAccountId);

      for (const row of totals) {
        reconTotals[row.reconAccountId] = parseFloat(row.total);
      }
    } catch {
      // reconciliation_items table may not exist yet
    }
  }

  // Fetch all periods for this client to find prev/next
  const allPeriods = await db
    .select({
      id: reconciliationPeriods.id,
      periodYear: reconciliationPeriods.periodYear,
      periodMonth: reconciliationPeriods.periodMonth,
    })
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.clientId, clientId))
    .orderBy(
      asc(reconciliationPeriods.periodYear),
      asc(reconciliationPeriods.periodMonth)
    );

  const currentIndex = allPeriods.findIndex((p) => p.id === periodId);
  const prevPeriod = currentIndex > 0 ? allPeriods[currentIndex - 1] : null;
  const nextPeriod =
    currentIndex < allPeriods.length - 1 ? allPeriods[currentIndex + 1] : null;

  const periodLabel = `${MONTH_NAMES[period.periodMonth - 1]} ${period.periodYear}`;
  const periodBadge = STATUS_BADGES[period.status] || STATUS_BADGES.draft;

  // Summary stats
  const totalAccounts = accounts.length;
  const draftCount = accounts.filter((a) => a.status === "draft").length;
  const inProgressCount = accounts.filter((a) => a.status === "in_progress").length;
  const reviewCount = accounts.filter((a) => a.status === "ready_for_review").length;
  const approvedCount = accounts.filter((a) => a.status === "approved").length;
  const reconciledCount = accounts.filter((a) => {
    const itemsTotal = reconTotals[a.id] || 0;
    const balance = parseFloat(a.balance);
    return Math.abs(balance - itemsTotal) < 0.01;
  }).length;
  const reconciledPct = totalAccounts > 0 ? Math.round((reconciledCount / totalAccounts) * 100) : 0;

  // Group accounts into balance sheet sections based on Xero account types
  const BS_SECTIONS: { label: string; types: string[] }[] = [
    { label: "Fixed Assets", types: ["Fixed Assets", "Non-current Asset", "Non Current Asset"] },
    { label: "Current Assets", types: ["Current Assets", "Current Asset", "Bank", "Inventory", "Prepayment"] },
    { label: "Current Liabilities", types: ["Current Liabilities", "Current Liability"] },
    { label: "Non-current Liabilities", types: ["Non-current Liabilities", "Non Current Liability", "Non-current Liability"] },
    { label: "Equity", types: ["Equity"] },
  ];

  function classifyAccount(accountType: string): string {
    const lower = accountType.toLowerCase();
    if (lower.includes("fixed") || (lower.includes("non") && lower.includes("asset")))
      return "Fixed Assets";
    if (lower.includes("asset") || lower === "bank" || lower === "inventory" || lower === "prepayment")
      return "Current Assets";
    if (lower.includes("non") && lower.includes("liabilit"))
      return "Non-current Liabilities";
    if (lower.includes("liabilit"))
      return "Current Liabilities";
    if (lower.includes("equity") || lower.includes("retained") || lower.includes("capital"))
      return "Equity";
    return "Other";
  }

  const sections = BS_SECTIONS.map((sec) => {
    const sectionAccounts = accounts.filter(
      (a) => classifyAccount(a.accountType) === sec.label
    );
    const total = sectionAccounts.reduce((s, a) => s + parseFloat(a.balance), 0);
    const priorTotal = sectionAccounts.reduce(
      (s, a) => s + (a.priorBalance ? parseFloat(a.priorBalance) : 0),
      0
    );
    return { ...sec, accounts: sectionAccounts, total, priorTotal };
  });

  // Accounts that don't fit any section
  const classified = new Set(sections.flatMap((s) => s.accounts.map((a) => a.id)));
  const otherAccounts = accounts.filter((a) => !classified.has(a.id));

  // Balance sheet totals
  const totalFixedAssets = sections[0].total;
  const totalCurrentAssets = sections[1].total;
  const totalAssets = totalFixedAssets + totalCurrentAssets;
  const totalCurrentLiabilities = sections[2].total;
  const totalNonCurrentLiabilities = sections[3].total;
  const totalLiabilities = totalCurrentLiabilities + totalNonCurrentLiabilities;
  const netAssets = totalAssets - totalLiabilities;
  const totalEquity = sections[4].total;
  const balances = Math.abs(netAssets - totalEquity) < 0.01;

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
          <div className="flex items-center gap-3">
            {prevPeriod ? (
              <Link
                href={`/clients/${clientId}/periods/${prevPeriod.id}`}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                title={`${MONTH_NAMES[prevPeriod.periodMonth - 1]} ${prevPeriod.periodYear}`}
              >
                &larr; {MONTH_NAMES[prevPeriod.periodMonth - 1].slice(0, 3)}
              </Link>
            ) : (
              <span className="inline-flex items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm font-medium text-gray-300">
                &larr;
              </span>
            )}
            <h1 className="text-2xl font-semibold">{periodLabel}</h1>
            {nextPeriod ? (
              <Link
                href={`/clients/${clientId}/periods/${nextPeriod.id}`}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                title={`${MONTH_NAMES[nextPeriod.periodMonth - 1]} ${nextPeriod.periodYear}`}
              >
                {MONTH_NAMES[nextPeriod.periodMonth - 1].slice(0, 3)} &rarr;
              </Link>
            ) : (
              <span className="inline-flex items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm font-medium text-gray-300">
                &rarr;
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span
              className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${periodBadge.className}`}
            >
              {periodBadge.label}
            </span>
            <span className="text-sm text-gray-500">
              {client.name} ({client.code})
            </span>
            {period.status === "approved" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Locked
              </span>
            )}
          </div>
        </div>
        {isManager && (
          <PullBalanceSheetButton periodId={periodId} />
        )}
      </div>

      {/* Reconciliation progress */}
      {totalAccounts > 0 && (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-gray-700">
                Reconciled: {reconciledCount}/{totalAccounts} ({reconciledPct}%)
              </span>
            </div>
            {reconciledCount === totalAccounts ? (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-green-700">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                All reconciled
              </span>
            ) : null}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-2 rounded-full transition-all ${
                reconciledPct === 100 ? "bg-green-500" : reconciledPct > 50 ? "bg-blue-500" : "bg-amber-500"
              }`}
              style={{ width: `${reconciledPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Summary cards */}
      {totalAccounts > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard label="Draft" count={draftCount} color="gray" />
          <SummaryCard label="In Progress" count={inProgressCount} color="blue" />
          <SummaryCard label="Review" count={reviewCount} color="yellow" />
          <SummaryCard label="Approved" count={approvedCount} color="green" />
        </div>
      )}

      {/* Balance Sheet */}
      {accounts.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-sm text-gray-500">
            No accounts yet. Pull the balance sheet from Xero to populate accounts.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-1">
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr className="border-b border-gray-200">
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Account
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Balance
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Prior
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Movement
                  </th>
                  <th className="w-24 px-6 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                    Recon
                  </th>
                  <th className="w-32 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => {
                  if (section.accounts.length === 0) return null;
                  return (
                    <BSSection
                      key={section.label}
                      label={section.label}
                      accounts={section.accounts}
                      total={section.total}
                      priorTotal={section.priorTotal}
                      clientId={clientId}
                      periodId={periodId}
                      reconTotals={reconTotals}
                    />
                  );
                })}
                {otherAccounts.length > 0 && (
                  <BSSection
                    label="Other"
                    accounts={otherAccounts}
                    total={otherAccounts.reduce((s, a) => s + parseFloat(a.balance), 0)}
                    priorTotal={otherAccounts.reduce(
                      (s, a) => s + (a.priorBalance ? parseFloat(a.priorBalance) : 0),
                      0
                    )}
                    clientId={clientId}
                    periodId={periodId}
                    reconTotals={reconTotals}
                  />
                )}
              </tbody>
              {/* Balance sheet summary */}
              <tfoot>
                <tr className="border-t-2 border-gray-400 bg-gray-50">
                  <td className="px-6 py-2 text-sm font-semibold text-gray-900">
                    Total Assets
                  </td>
                  <td className="px-6 py-2 text-right text-sm font-mono font-semibold text-gray-900">
                    {formatCurrency(totalAssets)}
                  </td>
                  <td colSpan={4} />
                </tr>
                <tr className="bg-gray-50">
                  <td className="px-6 py-2 text-sm font-semibold text-gray-900">
                    Total Liabilities
                  </td>
                  <td className="px-6 py-2 text-right text-sm font-mono font-semibold text-gray-900">
                    {formatCurrency(totalLiabilities)}
                  </td>
                  <td colSpan={4} />
                </tr>
                <tr className="border-t-2 border-gray-400 bg-gray-100">
                  <td className="px-6 py-3 text-sm font-bold text-gray-900">
                    Net Assets
                  </td>
                  <td className="px-6 py-3 text-right text-sm font-mono font-bold text-gray-900">
                    {formatCurrency(netAssets)}
                  </td>
                  <td colSpan={4} />
                </tr>
                <tr className="bg-gray-100">
                  <td className="px-6 py-3 text-sm font-bold text-gray-900">
                    Total Equity
                  </td>
                  <td className="px-6 py-3 text-right text-sm font-mono font-bold text-gray-900">
                    {formatCurrency(totalEquity)}
                  </td>
                  <td colSpan={4} />
                </tr>
                <tr className={`border-t-2 ${balances ? "border-green-400 bg-green-50" : "border-red-400 bg-red-50"}`}>
                  <td className={`px-6 py-3 text-sm font-bold ${balances ? "text-green-800" : "text-red-800"}`}>
                    {balances ? "Balance sheet balances" : "Balance sheet does NOT balance"}
                  </td>
                  <td className={`px-6 py-3 text-right text-sm font-mono font-bold ${balances ? "text-green-800" : "text-red-800"}`}>
                    {balances ? formatCurrency(0) : formatCurrency(netAssets - totalEquity)}
                  </td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
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

const STATUS_BADGES_ROW: Record<string, { label: string; className: string }> = STATUS_BADGES;

function BSSection({
  label,
  accounts,
  total,
  priorTotal,
  clientId,
  periodId,
  reconTotals,
}: {
  label: string;
  accounts: { id: string; accountCode: string | null; accountName: string; balance: string; priorBalance: string | null; status: string }[];
  total: number;
  priorTotal: number;
  clientId: string;
  periodId: string;
  reconTotals: Record<string, number>;
}) {
  const movement = total - priorTotal;

  return (
    <>
      {/* Section header */}
      <tr className="bg-gray-100 border-t border-gray-300">
        <td colSpan={6} className="px-6 py-2 text-xs font-bold uppercase tracking-wider text-gray-700">
          {label}
        </td>
      </tr>
      {/* Account rows */}
      {accounts.map((account) => {
        const balance = parseFloat(account.balance);
        const prior = account.priorBalance ? parseFloat(account.priorBalance) : null;
        const mov = prior !== null ? balance - prior : null;
        const badge = STATUS_BADGES_ROW[account.status] || STATUS_BADGES_ROW.draft;
        const itemsTotal = reconTotals[account.id] || 0;
        const variance = balance - itemsTotal;
        const isReconciled = Math.abs(variance) < 0.01;

        return (
          <tr key={account.id} className="border-t border-gray-100 hover:bg-gray-50">
            <td className="whitespace-nowrap px-6 py-2.5 text-sm text-gray-900">
              {account.accountCode && (
                <span className="mr-2 font-mono text-xs text-gray-400">{account.accountCode}</span>
              )}
              <Link
                href={`/clients/${clientId}/periods/${periodId}/accounts/${account.id}`}
                className="text-blue-600 hover:text-blue-800"
              >
                {account.accountName}
              </Link>
            </td>
            <td className="whitespace-nowrap px-6 py-2.5 text-right text-sm font-mono text-gray-900">
              {formatCurrency(balance)}
            </td>
            <td className="whitespace-nowrap px-6 py-2.5 text-right text-sm font-mono text-gray-400">
              {prior !== null ? formatCurrency(prior) : "-"}
            </td>
            <td
              className={`whitespace-nowrap px-6 py-2.5 text-right text-sm font-mono ${
                mov !== null && mov !== 0
                  ? mov > 0
                    ? "text-green-600"
                    : "text-red-600"
                  : "text-gray-300"
              }`}
            >
              {mov !== null ? formatCurrency(mov) : "-"}
            </td>
            <td className="whitespace-nowrap px-6 py-2.5 text-center text-sm">
              {isReconciled ? (
                <span className="inline-flex items-center gap-1 text-green-600" title="Reconciled">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              ) : itemsTotal !== 0 ? (
                <span className="text-xs text-red-500 font-mono" title={`Variance: ${formatCurrency(variance)}`}>
                  {formatCurrency(variance)}
                </span>
              ) : (
                <span className="text-xs text-gray-300">-</span>
              )}
            </td>
            <td className="whitespace-nowrap px-6 py-2.5 text-sm">
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
              >
                {badge.label}
              </span>
            </td>
          </tr>
        );
      })}
      {/* Section subtotal */}
      <tr className="border-t border-gray-300 bg-gray-50">
        <td className="px-6 py-2 text-sm font-semibold text-gray-700">
          Total {label}
        </td>
        <td className="px-6 py-2 text-right text-sm font-mono font-semibold text-gray-900">
          {formatCurrency(total)}
        </td>
        <td className="px-6 py-2 text-right text-sm font-mono text-gray-400">
          {formatCurrency(priorTotal)}
        </td>
        <td
          className={`px-6 py-2 text-right text-sm font-mono font-medium ${
            movement !== 0
              ? movement > 0
                ? "text-green-600"
                : "text-red-600"
              : "text-gray-300"
          }`}
        >
          {formatCurrency(movement)}
        </td>
        <td colSpan={2} />
      </tr>
    </>
  );
}

