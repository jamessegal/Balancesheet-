"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { saveClosingItems } from "@/app/actions/recon-modules";
import {
  addReconciliationItem,
  deleteReconciliationItem,
} from "@/app/actions/account-detail";

interface BFItem {
  id: string;
  description: string;
  amount: string;
}

interface GLMovement {
  id: string;
  transactionDate: string;
  description: string | null;
  reference: string | null;
  contact: string | null;
  source: string | null;
  debit: string | null;
  credit: string | null;
}

interface ClosingItem {
  id: string;
  description: string;
  amount: string;
  glTransactionId: string | null;
  createdByName: string | null;
}

interface Props {
  accountId: string;
  bfItems: BFItem[];
  bfTotal: number;
  movements: GLMovement[];
  closingItems: ClosingItem[];
  autoMatchMovementId: string | null;
  closingBalance: number;
}

export function PensionsPayableRecon({
  accountId,
  bfItems,
  bfTotal,
  movements,
  closingItems: initialClosingItems,
  autoMatchMovementId,
  closingBalance,
}: Props) {
  const router = useRouter();
  const [matchedMovementId, setMatchedMovementId] = useState<string | null>(
    autoMatchMovementId
  );
  const [bfCleared, setBfCleared] = useState(autoMatchMovementId !== null);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Separate movements into the matched payment and remaining accruals
  const matchedMovement = movements.find((m) => m.id === matchedMovementId);
  const unMatchedMovements = movements.filter(
    (m) => m.id !== matchedMovementId
  );

  const closingTotal = initialClosingItems.reduce(
    (sum, item) => sum + parseFloat(item.amount || "0"),
    0
  );
  const variance = closingBalance - closingTotal;

  const totalDebits = movements.reduce(
    (s, t) => s + parseFloat(t.debit || "0"),
    0
  );
  const totalCredits = movements.reduce(
    (s, t) => s + parseFloat(t.credit || "0"),
    0
  );
  const netMovement = totalCredits - totalDebits;

  // Detect BF rounding: BF exists, there's a payment that is close but not
  // exact, or BF is so small no payment matches at all. If the remaining
  // BF amount after best-match payment is tiny, offer to write it off.
  const matchedDebit = matchedMovement
    ? parseFloat(matchedMovement.debit || "0")
    : 0;
  const bfRounding = bfCleared
    ? Math.abs(bfTotal) - matchedDebit // e.g. BF 5306.91 matched to 5306.91 → 0
    : 0;
  // Small unmatched BF with no matching payment — the BF itself is the rounding
  const unmatchedSmallBf =
    !bfCleared && bfTotal !== 0 && Math.abs(bfTotal) <= 1.0;
  const showRoundingButton =
    (bfCleared && Math.abs(bfRounding) >= 0.01) || unmatchedSmallBf;
  const roundingAmount = unmatchedSmallBf ? bfTotal : bfRounding;

  function handleClearBF(movementId: string) {
    setMatchedMovementId(movementId);
    setBfCleared(true);
  }

  function handleUndoClear() {
    setMatchedMovementId(null);
    setBfCleared(false);
  }

  // Add BF rounding difference as a closing item
  async function handleAddRounding() {
    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("description", "Rounding difference (brought forward)");
    formData.set("amount", String(roundingAmount));

    const result = await addReconciliationItem(formData);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      // If it was an unmatched small BF, mark it as cleared now
      if (unmatchedSmallBf) {
        setBfCleared(true);
      }
      router.refresh();
    }
    setLoading(false);
  }

  // Add a GL transaction as a closing item
  async function handleAddFromGL(movement: GLMovement) {
    setLoading(true);
    setError(null);

    const net =
      parseFloat(movement.credit || "0") - parseFloat(movement.debit || "0");
    const desc =
      movement.description || movement.contact || movement.reference || "GL item";

    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("description", desc);
    formData.set("amount", String(net));

    const result = await addReconciliationItem(formData);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setLoading(false);
  }

  // Add a manual closing item
  async function handleAddManual(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !amount.trim()) return;

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("description", description);
    formData.set("amount", amount);

    const result = await addReconciliationItem(formData);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      setDescription("");
      setAmount("");
      router.refresh();
    }
    setLoading(false);
  }

  async function handleDelete(itemId: string) {
    setDeletingId(itemId);
    setError(null);
    const result = await deleteReconciliationItem(itemId);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setDeletingId(null);
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* ── Section 1: Brought Forward ── */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Brought Forward
        </h3>
        {bfItems.length > 0 ? (
          <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Description
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase text-gray-500">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {bfItems.map((item) => (
                  <tr
                    key={item.id}
                    className={bfCleared ? "bg-green-50 opacity-60" : ""}
                  >
                    <td className="px-4 py-2 text-sm text-gray-900">
                      {item.description}
                      {bfCleared && (
                        <span className="ml-2 text-xs text-green-600">
                          Cleared
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-mono text-gray-900">
                      {bfCleared ? (
                        <span className="line-through">
                          {formatCurrency(parseFloat(item.amount))}
                        </span>
                      ) : (
                        formatCurrency(parseFloat(item.amount))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr className="border-t-2 border-gray-300">
                  <td className="px-4 py-2 text-sm font-medium text-gray-900">
                    BF Total
                    {bfCleared && (
                      <button
                        onClick={handleUndoClear}
                        className="ml-3 text-xs text-blue-600 hover:text-blue-800"
                      >
                        Undo clear
                      </button>
                    )}
                  </td>
                  <td
                    className={`whitespace-nowrap px-4 py-2 text-right text-sm font-mono font-medium ${
                      bfCleared ? "text-green-600 line-through" : "text-gray-900"
                    }`}
                  >
                    {formatCurrency(bfTotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-gray-300 p-4 text-center">
            <p className="text-sm text-gray-500">
              No prior period reconciliation — this is the first period.
            </p>
          </div>
        )}

        {/* Rounding notice */}
        {showRoundingButton && (
          <div className="mt-2 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-amber-800">
                Rounding difference: {formatCurrency(Math.abs(roundingAmount))}
              </p>
              <p className="text-xs text-amber-600">
                {unmatchedSmallBf
                  ? "This small brought-forward balance appears to be a cumulative rounding difference."
                  : "The payment didn\u2019t exactly clear the brought-forward balance."}
                {" "}You can add it to closing and journal it off later.
              </p>
            </div>
            <button
              onClick={handleAddRounding}
              disabled={loading}
              className="ml-4 shrink-0 rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {loading ? "..." : "Add rounding to closing"}
            </button>
          </div>
        )}
      </div>

      {/* ── Section 2: Movements ── */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Movements this Period
        </h3>
        <p className="mt-1 text-xs text-gray-400">
          Debit payments clear the brought-forward balance. Credit accruals
          should be added to closing to explain the period-end balance.
        </p>
        {movements.length > 0 ? (
          <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Date
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Description
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Source
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase text-gray-500">
                    Debit
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase text-gray-500">
                    Credit
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium uppercase text-gray-500">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {movements.map((mov) => {
                  const isMatched = mov.id === matchedMovementId;
                  const debit = parseFloat(mov.debit || "0");
                  const credit = parseFloat(mov.credit || "0");
                  const isPayment = debit > 0 && credit === 0;
                  const isAutoSuggested = mov.id === autoMatchMovementId;

                  return (
                    <tr
                      key={mov.id}
                      className={
                        isMatched
                          ? "bg-green-50"
                          : isAutoSuggested && !bfCleared
                            ? "bg-yellow-50"
                            : "hover:bg-gray-50"
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-900">
                        {mov.transactionDate}
                      </td>
                      <td className="max-w-xs truncate px-4 py-2 text-sm text-gray-900">
                        {mov.description || mov.contact || "-"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-500">
                        {mov.source || "-"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-mono text-gray-900">
                        {debit > 0 ? formatCurrency(debit) : ""}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-mono text-gray-900">
                        {credit > 0 ? formatCurrency(credit) : ""}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-center text-sm">
                        {isMatched ? (
                          <span className="inline-flex items-center gap-1 rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            Clears brought forward
                          </span>
                        ) : isPayment && bfTotal !== 0 && !bfCleared ? (
                          <button
                            onClick={() => handleClearBF(mov.id)}
                            className={`rounded px-2 py-1 text-xs font-medium ${
                              isAutoSuggested
                                ? "animate-pulse bg-yellow-200 text-yellow-800 hover:bg-yellow-300"
                                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                            }`}
                          >
                            {isAutoSuggested
                              ? "Match to BF (exact amount)"
                              : "Match to BF"}
                          </button>
                        ) : !isMatched && !isPayment ? (
                          <button
                            onClick={() => handleAddFromGL(mov)}
                            disabled={loading}
                            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            Add to closing
                          </button>
                        ) : isPayment ? (
                          <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs text-gray-500">
                            Payment — no action needed
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr className="border-t-2 border-gray-300">
                  <td
                    colSpan={3}
                    className="px-4 py-2 text-sm font-medium text-gray-900"
                  >
                    Total
                  </td>
                  <td className="px-4 py-2 text-right text-sm font-mono font-medium text-gray-900">
                    {formatCurrency(totalDebits)}
                  </td>
                  <td className="px-4 py-2 text-right text-sm font-mono font-medium text-gray-900">
                    {formatCurrency(totalCredits)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-center text-xs font-medium text-gray-500">
                    Net: {formatCurrency(netMovement)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-gray-300 p-4 text-center">
            <p className="text-sm text-gray-500">
              No GL movements found for this period. Upload a GL report on the
              client page.
            </p>
          </div>
        )}
      </div>

      {/* ── Section 3: Closing Reconciliation ── */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Closing Reconciliation
        </h3>
        <p className="mt-1 text-xs text-gray-400">
          Items that make up the closing balance. Should match the balance sheet.
        </p>

        {/* Add manual item form */}
        <form
          onSubmit={handleAddManual}
          className="mt-3 rounded-lg border border-gray-200 bg-white p-3"
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (e.g. January pension accrual)"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm text-right font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading || !description.trim() || !amount.trim()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "..." : "Add"}
            </button>
          </div>
        </form>

        {/* Closing items table */}
        {initialClosingItems.length > 0 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Description
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase text-gray-500">
                    Amount
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase text-gray-500 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {initialClosingItems.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-sm text-gray-900">
                      {item.description}
                      {item.glTransactionId && (
                        <span className="ml-2 text-xs text-gray-400">
                          (from GL)
                        </span>
                      )}
                      {item.createdByName && (
                        <span className="ml-2 text-xs text-gray-400">
                          {item.createdByName}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-mono text-gray-900">
                      {formatCurrency(parseFloat(item.amount))}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <button
                        onClick={() => handleDelete(item.id)}
                        disabled={deletingId === item.id}
                        className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                      >
                        {deletingId === item.id ? "..." : "Remove"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr className="border-t-2 border-gray-300">
                  <td className="px-4 py-2 text-sm font-medium text-gray-900">
                    Closing Total
                  </td>
                  <td className="px-4 py-2 text-right text-sm font-mono font-medium text-gray-900">
                    {formatCurrency(closingTotal)}
                  </td>
                  <td />
                </tr>
                <tr className="border-t border-gray-200">
                  <td className="px-4 py-2 text-sm font-medium text-gray-900">
                    Balance per BS
                  </td>
                  <td className="px-4 py-2 text-right text-sm font-mono font-medium text-gray-900">
                    {formatCurrency(closingBalance)}
                  </td>
                  <td />
                </tr>
                <tr className="border-t border-gray-300">
                  <td className="px-4 py-2 text-sm font-semibold text-gray-900">
                    Variance
                  </td>
                  <td
                    className={`px-4 py-2 text-right text-sm font-mono font-semibold ${
                      Math.abs(variance) < 0.01
                        ? "text-green-600"
                        : "text-red-600"
                    }`}
                  >
                    {formatCurrency(variance)}
                    {Math.abs(variance) < 0.01 ? " \u2713" : ""}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Empty state */}
        {initialClosingItems.length === 0 && (
          <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4">
            <p className="text-sm font-medium text-gray-700">
              No closing items yet
            </p>
            <p className="mt-1 text-xs text-gray-500">
              The closing balance is{" "}
              <span className="font-semibold">
                {formatCurrency(closingBalance)}
              </span>
              . To reconcile, use the{" "}
              <span className="inline-flex items-center rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                Add to closing
              </span>{" "}
              buttons on credit movements above, or add items manually using the
              form.
            </p>
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
