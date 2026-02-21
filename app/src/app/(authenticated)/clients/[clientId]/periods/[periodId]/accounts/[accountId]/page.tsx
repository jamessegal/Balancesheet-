import { db } from "@/lib/db";
import {
  clients,
  reconciliationPeriods,
  reconciliationAccounts,
  accountTransactions,
  reconciliationItems,
  accountNotes,
  users,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasMinRole } from "@/lib/authorization";
import Link from "next/link";
import { AccountStatusControl } from "@/components/account-status";
import { PullTransactionsButton } from "@/components/pull-transactions";
import { AddNoteForm } from "@/components/add-note";
import { ReconciliationSchedule } from "@/components/reconciliation-schedule";

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

const NOTE_TYPE_LABELS: Record<string, { label: string; className: string }> = {
  prep: { label: "Prep", className: "bg-blue-100 text-blue-700" },
  review: { label: "Review", className: "bg-purple-100 text-purple-700" },
  general: { label: "General", className: "bg-gray-100 text-gray-700" },
};

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ clientId: string; periodId: string; accountId: string }>;
}) {
  const { clientId, periodId, accountId } = await params;
  const session = await auth();
  const userRole = session!.user.role as "admin" | "manager" | "junior";
  const isManager = hasMinRole(userRole, "manager");

  // Load data
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

  const [account] = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);
  if (!account || account.periodId !== periodId) notFound();

  const transactions = await db
    .select()
    .from(accountTransactions)
    .where(eq(accountTransactions.reconAccountId, accountId))
    .orderBy(accountTransactions.transactionDate);

  const notes = await db
    .select({
      id: accountNotes.id,
      noteType: accountNotes.noteType,
      content: accountNotes.content,
      createdAt: accountNotes.createdAt,
      createdByName: users.name,
    })
    .from(accountNotes)
    .leftJoin(users, eq(accountNotes.createdBy, users.id))
    .where(eq(accountNotes.reconAccountId, accountId))
    .orderBy(desc(accountNotes.createdAt));

  // Gracefully handle missing table (migration 0002 may not be applied yet)
  let reconItems: {
    id: string;
    description: string;
    amount: string;
    createdAt: Date;
    createdByName: string | null;
  }[] = [];
  try {
    reconItems = await db
      .select({
        id: reconciliationItems.id,
        description: reconciliationItems.description,
        amount: reconciliationItems.amount,
        createdAt: reconciliationItems.createdAt,
        createdByName: users.name,
      })
      .from(reconciliationItems)
      .leftJoin(users, eq(reconciliationItems.createdBy, users.id))
      .where(eq(reconciliationItems.reconAccountId, accountId))
      .orderBy(reconciliationItems.createdAt);
  } catch {
    // Table doesn't exist yet — show empty schedule
  }

  const periodLabel = `${MONTH_NAMES[period.periodMonth - 1]} ${period.periodYear}`;
  const badge = STATUS_BADGES[account.status] || STATUS_BADGES.draft;
  const balance = parseFloat(account.balance);
  const prior = account.priorBalance ? parseFloat(account.priorBalance) : null;
  const movement = prior !== null ? balance - prior : null;

  return (
    <div>
      {/* Breadcrumbs */}
      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm text-gray-500">
        <Link href="/clients" className="hover:text-gray-700">Clients</Link>
        <span>/</span>
        <Link href={`/clients/${clientId}`} className="hover:text-gray-700">{client.name}</Link>
        <span>/</span>
        <Link href={`/clients/${clientId}/periods/${periodId}`} className="hover:text-gray-700">{periodLabel}</Link>
        <span>/</span>
        <span className="text-gray-900">{account.accountName}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {account.accountCode && (
              <span className="font-mono text-gray-500">{account.accountCode}</span>
            )}{" "}
            {account.accountName}
          </h1>
          <div className="mt-2 flex items-center gap-3">
            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
              {badge.label}
            </span>
            <span className="text-sm text-gray-500">{account.accountType}</span>
          </div>
        </div>
      </div>

      {/* Balance cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-sm font-medium text-gray-500">Current Balance</p>
          <p className="mt-1 text-2xl font-semibold">{formatCurrency(balance)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-sm font-medium text-gray-500">Prior Balance</p>
          <p className="mt-1 text-2xl font-semibold text-gray-600">
            {prior !== null ? formatCurrency(prior) : "-"}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-sm font-medium text-gray-500">Movement</p>
          <p className={`mt-1 text-2xl font-semibold ${
            movement !== null && movement !== 0
              ? movement > 0 ? "text-green-600" : "text-red-600"
              : "text-gray-400"
          }`}>
            {movement !== null ? formatCurrency(movement) : "-"}
          </p>
        </div>
      </div>

      {/* Status control */}
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-medium text-gray-500">Workflow</h2>
        <AccountStatusControl
          accountId={accountId}
          currentStatus={account.status}
          isManager={isManager}
        />
      </div>

      {/* Transactions */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">
            Transactions ({transactions.length})
          </h2>
          {isManager && <PullTransactionsButton accountId={accountId} />}
        </div>

        {transactions.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-8 text-center">
            <p className="text-sm text-gray-500">
              No transactions yet. Pull from Xero to load transactions for this account.
            </p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Description</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Reference</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Source</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Debit</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {transactions.map((txn) => (
                  <tr key={txn.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                      {txn.transactionDate}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-sm text-gray-900">
                      {txn.description || "-"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                      {txn.reference || "-"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                      {txn.sourceType || "-"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-mono text-gray-900">
                      {parseFloat(txn.debit || "0") > 0 ? formatCurrency(parseFloat(txn.debit!)) : ""}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-mono text-gray-900">
                      {parseFloat(txn.credit || "0") > 0 ? formatCurrency(parseFloat(txn.credit!)) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-sm font-medium text-gray-900">
                    Total
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                    {formatCurrency(transactions.reduce((s, t) => s + parseFloat(t.debit || "0"), 0))}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                    {formatCurrency(transactions.reduce((s, t) => s + parseFloat(t.credit || "0"), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Reconciliation Schedule */}
      <div className="mt-8">
        <h2 className="text-lg font-medium">Reconciliation Schedule</h2>
        <p className="mt-1 text-sm text-gray-500">
          List the items that make up the closing balance. Variance should be zero.
        </p>
        <div className="mt-4">
          <ReconciliationSchedule
            accountId={accountId}
            items={reconItems}
            closingBalance={balance}
          />
        </div>
      </div>

      {/* Notes */}
      <div className="mt-8">
        <h2 className="text-lg font-medium">Notes</h2>

        <div className="mt-4">
          <AddNoteForm accountId={accountId} />
        </div>

        {notes.length > 0 && (
          <div className="mt-4 space-y-3">
            {notes.map((note) => {
              const nt = NOTE_TYPE_LABELS[note.noteType] || NOTE_TYPE_LABELS.general;
              return (
                <div key={note.id} className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${nt.className}`}>
                      {nt.label}
                    </span>
                    <span className="text-xs text-gray-500">
                      {note.createdByName} &middot; {new Date(note.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-gray-900 whitespace-pre-wrap">{note.content}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
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
