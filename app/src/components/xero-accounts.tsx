"use client";

import { useState } from "react";
import { fetchChartOfAccounts, type ChartOfAccounts } from "@/app/actions/accounts";

export function XeroAccountsPanel({ clientId }: { clientId: string }) {
  const [accounts, setAccounts] = useState<ChartOfAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleFetch() {
    setLoading(true);
    setError(null);

    const result = await fetchChartOfAccounts(clientId);

    if ("error" in result) {
      setError(result.error);
    } else {
      setAccounts(result.accounts);
    }

    setLoading(false);
  }

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Chart of Accounts</h2>
        <button
          onClick={handleFetch}
          disabled={loading}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Fetching..." : accounts ? "Refresh" : "Fetch from Xero"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md bg-red-50 border border-red-200 p-3">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {accounts && (
        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Code
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Name
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Type
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Class
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {accounts.map((account) => (
                <tr key={account.accountId} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-2 text-sm font-mono text-gray-900">
                    {account.code}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-900">
                    {account.name}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-500">
                    {account.type}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-500">
                    {account.class}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bg-gray-50 px-4 py-2 text-xs text-gray-500">
            {accounts.length} active accounts
          </div>
        </div>
      )}
    </div>
  );
}
