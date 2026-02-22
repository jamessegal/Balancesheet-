"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  getReconConfigs,
  getUnmappedAccounts,
  bulkSetReconModules,
  RECON_MODULES,
} from "@/app/actions/recon-config";

interface ReconConfig {
  id: string;
  clientId: string;
  xeroAccountId: string | null;
  accountName: string;
  reconModule: string;
}

interface UnmappedAccount {
  xeroAccountId: string;
  accountName: string;
  accountType: string;
}

export function ReconConfigPanel({ clientId }: { clientId: string }) {
  const [configs, setConfigs] = useState<ReconConfig[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();

  useEffect(() => {
    async function load() {
      try {
        const [configData, unmappedData] = await Promise.all([
          getReconConfigs(clientId),
          getUnmappedAccounts(clientId),
        ]);
        setConfigs(configData);
        setUnmapped(unmappedData);
      } catch {
        // Tables may not exist yet
      }
      setLoading(false);
    }
    load();
  }, [clientId]);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const formData = new FormData(e.currentTarget);
    await bulkSetReconModules(formData);
    // Reload
    const [configData, unmappedData] = await Promise.all([
      getReconConfigs(clientId),
      getUnmappedAccounts(clientId),
    ]);
    setConfigs(configData);
    setUnmapped(unmappedData);
    setSaving(false);
    router.refresh();
  }

  // Merge configs and unmapped into one list for display
  const allAccounts = [
    ...configs.map((c) => ({
      xeroAccountId: c.xeroAccountId || "",
      accountName: c.accountName,
      reconModule: c.reconModule,
      isMapped: true,
    })),
    ...unmapped.map((u) => ({
      xeroAccountId: u.xeroAccountId,
      accountName: u.accountName,
      reconModule: "simple_list",
      isMapped: false,
    })),
  ].sort((a, b) => a.accountName.localeCompare(b.accountName));

  if (loading) {
    return (
      <div className="mt-8">
        <h2 className="text-lg font-medium">Reconciliation Config</h2>
        <p className="mt-2 text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  if (allAccounts.length === 0) {
    return null;
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Reconciliation Config</h2>
          <p className="mt-1 text-sm text-gray-500">
            Map balance sheet accounts to reconciliation module types.
          </p>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          {expanded ? "Collapse" : "Configure"}
        </button>
      </div>

      {/* Warning for unmapped accounts */}
      {unmapped.length > 0 && (
        <div className="mt-3 rounded-md border border-yellow-200 bg-yellow-50 p-3">
          <p className="text-sm text-yellow-800">
            {unmapped.length} account{unmapped.length > 1 ? "s" : ""} not yet
            mapped to a reconciliation module.
          </p>
        </div>
      )}

      {/* Summary when collapsed */}
      {!expanded && configs.length > 0 && (
        <div className="mt-3 text-sm text-gray-500">
          {configs.length} account{configs.length !== 1 ? "s" : ""} configured
        </div>
      )}

      {/* Full config table when expanded */}
      {expanded && (
        <form onSubmit={handleSave} className="mt-4">
          <input type="hidden" name="clientId" value={clientId} />
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Account
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Reconciliation Module
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {allAccounts.map((account) => (
                  <tr
                    key={account.xeroAccountId}
                    className={
                      !account.isMapped ? "bg-yellow-50" : "hover:bg-gray-50"
                    }
                  >
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {account.accountName}
                      <input
                        type="hidden"
                        name={`name_${account.xeroAccountId}`}
                        value={account.accountName}
                      />
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {account.isMapped ? (
                        <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          Mapped
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                          Unmapped
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        name={`module_${account.xeroAccountId}`}
                        defaultValue={account.reconModule}
                        className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        {RECON_MODULES.map((mod) => (
                          <option key={mod.value} value={mod.value}>
                            {mod.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Configuration"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
