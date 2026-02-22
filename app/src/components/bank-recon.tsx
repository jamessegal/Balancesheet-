"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  saveBankReconStatement,
  addBankReconItem,
  toggleBankReconItem,
  deleteBankReconItem,
  uploadBankStatement,
  deleteBankStatementFile,
} from "@/app/actions/bank-recon";

interface StatementData {
  id: string;
  statementDate: string;
  statementBalance: string;
  glBalance: string;
  currency: string;
  documentFileName: string | null;
  status: string;
  notes: string | null;
  confirmedByName: string | null;
  confirmedAt: Date | null;
}

interface ReconItem {
  id: string;
  itemType: string;
  description: string;
  amount: string;
  transactionDate: string | null;
  reference: string | null;
  xeroTransactionId: string | null;
  source: string;
  isTicked: boolean;
}

interface Props {
  accountId: string;
  glBalance: number;
  monthEndDate: string;
  periodYear: number;
  periodMonth: number;
  statement: StatementData | null;
  reconItems: ReconItem[];
}

const ITEM_TYPE_LABELS: Record<string, { label: string; className: string }> = {
  unpresented_payment: {
    label: "Unpresented",
    className: "bg-orange-100 text-orange-700",
  },
  outstanding_deposit: {
    label: "Outstanding Deposit",
    className: "bg-blue-100 text-blue-700",
  },
  bank_not_in_gl: {
    label: "Bank not in GL",
    className: "bg-purple-100 text-purple-700",
  },
  other: { label: "Other", className: "bg-gray-100 text-gray-700" },
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
  AUD: "A$",
  NZD: "NZ$",
  CAD: "C$",
};

export function BankRecon({
  accountId,
  glBalance,
  monthEndDate,
  periodYear,
  periodMonth,
  statement: initialStatement,
  reconItems: initialReconItems,
}: Props) {
  const router = useRouter();

  // Statement form state
  const [statementDate, setStatementDate] = useState(
    initialStatement?.statementDate || monthEndDate
  );
  const [statementBalance, setStatementBalance] = useState(
    initialStatement?.statementBalance || ""
  );
  const [currency, setCurrency] = useState(
    initialStatement?.currency || "GBP"
  );
  const [notes, setNotes] = useState(initialStatement?.notes || "");

  // UI state
  const [saving, setSaving] = useState(false);
  const [addingManual, setAddingManual] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingFile, setDeletingFile] = useState(false);

  // Manual item form
  const [manualDesc, setManualDesc] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualType, setManualType] = useState("other");
  const [manualDate, setManualDate] = useState("");
  const [manualRef, setManualRef] = useState("");

  const currencySymbol = CURRENCY_SYMBOLS[currency] || currency;
  const hasStatement = !!initialStatement;
  const stmtBal = hasStatement
    ? parseFloat(initialStatement!.statementBalance)
    : null;
  const variance = stmtBal !== null ? stmtBal - glBalance : null;
  const isExactMatch = variance !== null && Math.abs(variance) < 0.005;

  // Date validation
  const lastDay = new Date(periodYear, periodMonth, 0).getDate();
  const expectedMonthEnd = `${periodYear}-${String(periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const dateMatchesMonthEnd = statementDate === expectedMonthEnd;

  // Reconciling items calculations
  const tickedItems = initialReconItems.filter((i) => i.isTicked);
  const tickedTotal = tickedItems.reduce(
    (sum, i) => sum + parseFloat(i.amount),
    0
  );
  const allItemsTotal = initialReconItems.reduce(
    (sum, i) => sum + parseFloat(i.amount),
    0
  );
  const adjustedVariance =
    variance !== null ? variance - tickedTotal : null;
  const reconciledWithItems =
    adjustedVariance !== null && Math.abs(adjustedVariance) < 0.005;
  const unexplainedRemainder =
    variance !== null ? variance - allItemsTotal : null;

  // Overall status determination
  const status = initialStatement?.status || "pending";
  const isReconciled = isExactMatch || reconciledWithItems;

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  async function handleSaveStatement(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("statementDate", statementDate);
    formData.set("statementBalance", statementBalance);
    formData.set("currency", currency);
    formData.set("notes", notes);

    const result = await saveBankReconStatement(formData);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setSaving(false);
  }

  async function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("file", file);

    const result = await uploadBankStatement(formData);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setUploading(false);
    // Reset the file input
    e.target.value = "";
  }

  async function handleDeleteFile() {
    if (!initialStatement) return;
    setDeletingFile(true);
    setError(null);

    const result = await deleteBankStatementFile(initialStatement.id);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setDeletingFile(false);
  }

  async function handleAddManualItem(e: React.FormEvent) {
    e.preventDefault();
    if (!manualDesc.trim() || !manualAmount.trim()) return;

    setAddingManual(true);
    setError(null);

    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("description", manualDesc);
    formData.set("amount", manualAmount);
    formData.set("itemType", manualType);
    if (manualDate) formData.set("transactionDate", manualDate);
    if (manualRef) formData.set("reference", manualRef);
    formData.set("source", "manual");

    const result = await addBankReconItem(formData);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      setManualDesc("");
      setManualAmount("");
      setManualType("other");
      setManualDate("");
      setManualRef("");
      router.refresh();
    }
    setAddingManual(false);
  }

  async function handleToggleItem(itemId: string, currentTicked: boolean) {
    setTogglingId(itemId);
    const result = await toggleBankReconItem(itemId, !currentTicked);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setTogglingId(null);
  }

  async function handleDeleteItem(itemId: string) {
    setDeletingId(itemId);
    const result = await deleteBankReconItem(itemId);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setDeletingId(null);
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Reconciliation status banner */}
      {hasStatement && isReconciled && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <svg
            className="h-5 w-5 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm font-medium text-green-800">
            {isExactMatch
              ? "Reconciled — bank statement matches GL balance"
              : "Reconciled (with items) — reconciling items explain the difference"}
          </p>
          {initialStatement?.confirmedByName && (
            <span className="ml-auto text-xs text-green-600">
              Confirmed by {initialStatement.confirmedByName}
              {initialStatement.confirmedAt &&
                ` on ${new Date(initialStatement.confirmedAt).toLocaleDateString()}`}
            </span>
          )}
        </div>
      )}

      {hasStatement && !isReconciled && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <svg
            className="h-5 w-5 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm font-medium text-red-800">
            Not reconciled — variance of{" "}
            {formatAmount(Math.abs(variance!), currencySymbol)}
          </p>
        </div>
      )}

      {/* Statement date warning */}
      {hasStatement && !dateMatchesMonthEnd && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <svg
            className="h-4 w-4 text-amber-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <p className="text-sm text-amber-800">
            Statement date ({statementDate}) doesn&apos;t match month-end (
            {expectedMonthEnd})
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* ── Section 1: Balance Comparison ── */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Bank Statement
        </h3>

        <form onSubmit={handleSaveStatement} className="mt-3">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {/* Statement date */}
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Statement Date
                </label>
                <input
                  type="date"
                  value={statementDate}
                  onChange={(e) => setStatementDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              {/* Statement balance */}
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Closing Balance per Statement
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={statementBalance}
                  onChange={(e) => setStatementBalance(e.target.value)}
                  placeholder="0.00"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-right font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              {/* Currency */}
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Currency
                </label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="GBP">GBP (£)</option>
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                  <option value="AUD">AUD (A$)</option>
                  <option value="NZD">NZD (NZ$)</option>
                  <option value="CAD">CAD (C$)</option>
                </select>
              </div>

              {/* Save button */}
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={saving || !statementBalance}
                  className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving
                    ? "Saving..."
                    : hasStatement
                      ? "Update Statement"
                      : "Save Statement"}
                </button>
              </div>
            </div>

            {/* Notes */}
            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-500">
                Notes (optional)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Statement downloaded from Barclays online banking"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        </form>
      </div>

      {/* ── Statement Document Upload ── */}
      {hasStatement && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-gray-500">
              Bank Statement Document
            </label>
          </div>
          {initialStatement?.documentFileName ? (
            <div className="mt-2 flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2">
                <svg
                  className="h-4 w-4 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                  />
                </svg>
                <a
                  href={`/api/bank-statement/${initialStatement.id}/download`}
                  className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {initialStatement.documentFileName}
                </a>
              </div>
              <button
                onClick={handleDeleteFile}
                disabled={deletingFile}
                className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
              >
                {deletingFile ? "Removing..." : "Remove"}
              </button>
            </div>
          ) : (
            <div className="mt-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500 hover:border-gray-400 hover:bg-gray-50">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  />
                </svg>
                {uploading
                  ? "Uploading..."
                  : "Upload bank statement (PDF, image, or Excel)"}
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.csv"
                  onChange={handleUploadFile}
                  disabled={uploading}
                  className="hidden"
                />
              </label>
              <p className="mt-1 text-xs text-gray-400">
                For manager review. Max 5MB.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Section 2: Balance Comparison Table ── */}
      {hasStatement && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Balance Comparison
          </h3>
          <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200">
              <tbody className="divide-y divide-gray-200">
                <tr>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    Balance per GL (Xero)
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                    {formatAmount(glBalance, currencySymbol)}
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    Balance per Bank Statement
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                    {formatAmount(stmtBal!, currencySymbol)}
                  </td>
                </tr>
                <tr
                  className={
                    isExactMatch
                      ? "bg-green-50"
                      : "bg-red-50"
                  }
                >
                  <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                    Variance
                  </td>
                  <td
                    className={`px-4 py-3 text-right text-sm font-mono font-semibold ${
                      isExactMatch ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {formatAmount(variance!, currencySymbol)}
                    {isExactMatch ? " \u2713" : ""}
                  </td>
                </tr>
                {/* Show adjusted variance when items are ticked */}
                {!isExactMatch && tickedItems.length > 0 && (
                  <>
                    <tr>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        Less: ticked reconciling items ({tickedItems.length})
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-mono text-gray-600">
                        {formatAmount(tickedTotal, currencySymbol)}
                      </td>
                    </tr>
                    <tr
                      className={
                        reconciledWithItems ? "bg-green-50" : "bg-amber-50"
                      }
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                        Adjusted Variance
                      </td>
                      <td
                        className={`px-4 py-3 text-right text-sm font-mono font-semibold ${
                          reconciledWithItems
                            ? "text-green-600"
                            : "text-amber-700"
                        }`}
                      >
                        {formatAmount(adjustedVariance!, currencySymbol)}
                        {reconciledWithItems ? " \u2713" : ""}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Section 3: Reconciling Items (only when mismatched) ── */}
      {hasStatement && !isExactMatch && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Reconciling Items
          </h3>

          <p className="mt-1 text-xs text-gray-400">
            Tick the items that explain the difference between the GL and bank
            statement balances. When the ticked items account for the full
            variance, the reconciliation is complete.
          </p>

          {/* Items table */}
          {initialReconItems.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="w-10 px-3 py-2 text-center text-xs font-medium uppercase text-gray-500">
                      <span className="sr-only">Tick</span>
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                      Type
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                      Description
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                      Date
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                      Ref
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase text-gray-500">
                      Amount
                    </th>
                    <th className="w-12 px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {initialReconItems.map((item) => {
                    const typeInfo =
                      ITEM_TYPE_LABELS[item.itemType] ||
                      ITEM_TYPE_LABELS.other;
                    return (
                      <tr
                        key={item.id}
                        className={
                          item.isTicked
                            ? "bg-green-50"
                            : "hover:bg-gray-50"
                        }
                      >
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={item.isTicked}
                            onChange={() =>
                              handleToggleItem(item.id, item.isTicked)
                            }
                            disabled={togglingId === item.id}
                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${typeInfo.className}`}
                          >
                            {typeInfo.label}
                          </span>
                        </td>
                        <td className="max-w-xs truncate px-4 py-2 text-sm text-gray-900">
                          {item.description}
                          {item.source === "xero_auto" && (
                            <span className="ml-2 text-xs text-gray-400">
                              (from Xero)
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-500">
                          {item.transactionDate || "-"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-500">
                          {item.reference || "-"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-mono text-gray-900">
                          {formatAmount(
                            parseFloat(item.amount),
                            currencySymbol
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            disabled={deletingId === item.id}
                            className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                          >
                            {deletingId === item.id ? "..." : "x"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50">
                  <tr className="border-t-2 border-gray-300">
                    <td />
                    <td
                      colSpan={4}
                      className="px-4 py-2 text-sm font-medium text-gray-900"
                    >
                      Total (all items)
                    </td>
                    <td className="px-4 py-2 text-right text-sm font-mono font-medium text-gray-900">
                      {formatAmount(allItemsTotal, currencySymbol)}
                    </td>
                    <td />
                  </tr>
                  {tickedItems.length > 0 &&
                    tickedItems.length !== initialReconItems.length && (
                      <tr className="border-t border-gray-200">
                        <td />
                        <td
                          colSpan={4}
                          className="px-4 py-2 text-sm text-gray-600"
                        >
                          Total (ticked only)
                        </td>
                        <td className="px-4 py-2 text-right text-sm font-mono text-gray-600">
                          {formatAmount(tickedTotal, currencySymbol)}
                        </td>
                        <td />
                      </tr>
                    )}
                  {unexplainedRemainder !== null &&
                    Math.abs(unexplainedRemainder) >= 0.005 && (
                      <tr className="border-t border-gray-200">
                        <td />
                        <td
                          colSpan={4}
                          className="px-4 py-2 text-sm font-medium text-amber-700"
                        >
                          Unexplained remainder
                        </td>
                        <td className="px-4 py-2 text-right text-sm font-mono font-medium text-amber-700">
                          {formatAmount(
                            unexplainedRemainder,
                            currencySymbol
                          )}
                        </td>
                        <td />
                      </tr>
                    )}
                </tfoot>
              </table>
            </div>
          )}

          {initialReconItems.length === 0 && (
            <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-6 text-center">
              <p className="text-sm text-gray-500">
                No reconciling items yet. Add items manually below to explain
                the variance.
              </p>
            </div>
          )}

          {/* Add manual item form */}
          <form
            onSubmit={handleAddManualItem}
            className="mt-3 rounded-lg border border-gray-200 bg-white p-3"
          >
            <p className="mb-2 text-xs font-medium text-gray-500">
              Add reconciling item manually
            </p>
            <div className="flex flex-wrap gap-2">
              <select
                value={manualType}
                onChange={(e) => setManualType(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="unpresented_payment">
                  Unpresented Payment
                </option>
                <option value="outstanding_deposit">
                  Outstanding Deposit
                </option>
                <option value="bank_not_in_gl">Bank not in GL</option>
                <option value="other">Other</option>
              </select>
              <input
                type="text"
                value={manualDesc}
                onChange={(e) => setManualDesc(e.target.value)}
                placeholder="Description"
                className="min-w-[200px] flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <input
                type="date"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
                className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <input
                type="text"
                value={manualRef}
                onChange={(e) => setManualRef(e.target.value)}
                placeholder="Ref"
                className="w-28 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <input
                type="number"
                step="0.01"
                value={manualAmount}
                onChange={(e) => setManualAmount(e.target.value)}
                placeholder="Amount"
                className="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm text-right font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={
                  addingManual ||
                  !manualDesc.trim() ||
                  !manualAmount.trim()
                }
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {addingManual ? "..." : "Add"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Section 4: Empty state when no statement saved yet ── */}
      {!hasStatement && (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm font-medium text-gray-700">
            Enter the closing balance from your bank statement above
          </p>
          <p className="mt-1 text-xs text-gray-500">
            The GL balance from Xero is{" "}
            <span className="font-semibold">
              {formatAmount(glBalance, currencySymbol)}
            </span>
            . Enter the matching figure from the bank statement and click Save
            to begin reconciliation.
          </p>
        </div>
      )}
    </div>
  );
}

function formatAmount(amount: number, symbol: string): string {
  const formatted = Math.abs(amount).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0
    ? `(${symbol}${formatted})`
    : `${symbol}${formatted}`;
}
