"use client";

import { useState } from "react";
import {
  addReconciliationItem,
  deleteReconciliationItem,
} from "@/app/actions/account-detail";
import { useRouter } from "next/navigation";

interface ReconciliationItemRow {
  id: string;
  description: string;
  amount: string;
  createdByName: string | null;
  createdAt: Date;
}

interface Props {
  accountId: string;
  items: ReconciliationItemRow[];
  closingBalance: number;
}

export function ReconciliationSchedule({
  accountId,
  items,
  closingBalance,
}: Props) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const totalReconciled = items.reduce(
    (sum, item) => sum + parseFloat(item.amount || "0"),
    0
  );
  const variance = closingBalance - totalReconciled;

  async function handleAdd(e: React.FormEvent) {
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
    <div>
      {/* Add item form */}
      <form
        onSubmit={handleAdd}
        className="rounded-lg border border-gray-200 bg-white p-4"
      >
        <div className="flex gap-3">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (e.g. January payroll accrual)"
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
            {loading ? "Adding..." : "Add"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </form>

      {/* Items table */}
      {items.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Description
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Amount
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 w-20">
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {item.description}
                    <span className="ml-2 text-xs text-gray-400">
                      {item.createdByName}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-mono text-gray-900">
                    {formatCurrency(parseFloat(item.amount))}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
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
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  Total Reconciled
                </td>
                <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                  {formatCurrency(totalReconciled)}
                </td>
                <td />
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  Balance per BS
                </td>
                <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                  {formatCurrency(closingBalance)}
                </td>
                <td />
              </tr>
              <tr className="border-t border-gray-300">
                <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                  Variance
                </td>
                <td
                  className={`px-4 py-3 text-right text-sm font-mono font-semibold ${
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

      {/* Empty state — show just the balance to reconcile */}
      {items.length === 0 && (
        <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm text-gray-500">
            No reconciling items yet. Add items to explain the{" "}
            <span className="font-semibold">{formatCurrency(closingBalance)}</span>{" "}
            balance.
          </p>
        </div>
      )}
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
