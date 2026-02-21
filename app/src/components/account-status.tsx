"use client";

import { useState } from "react";
import { updateAccountStatus } from "@/app/actions/account-detail";
import { useRouter } from "next/navigation";

const TRANSITIONS: Record<string, { label: string; target: string; className: string; requiresManager?: boolean }[]> = {
  draft: [
    { label: "Start Work", target: "in_progress", className: "bg-blue-600 text-white hover:bg-blue-700" },
  ],
  in_progress: [
    { label: "Submit for Review", target: "ready_for_review", className: "bg-yellow-600 text-white hover:bg-yellow-700" },
  ],
  ready_for_review: [
    { label: "Return for Rework", target: "in_progress", className: "border border-gray-300 text-gray-700 hover:bg-gray-50", requiresManager: true },
    { label: "Approve", target: "approved", className: "bg-green-600 text-white hover:bg-green-700", requiresManager: true },
  ],
  approved: [
    { label: "Reopen", target: "reopened", className: "border border-red-300 text-red-700 hover:bg-red-50", requiresManager: true },
  ],
  reopened: [
    { label: "Start Rework", target: "in_progress", className: "bg-blue-600 text-white hover:bg-blue-700" },
  ],
};

export function AccountStatusControl({
  accountId,
  currentStatus,
  isManager,
}: {
  accountId: string;
  currentStatus: string;
  isManager: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const actions = (TRANSITIONS[currentStatus] || []).filter(
    (a) => !a.requiresManager || isManager
  );

  async function handleTransition(target: string) {
    setLoading(true);
    setError(null);

    const result = await updateAccountStatus(accountId, target);

    if ("error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }

    setLoading(false);
  }

  if (actions.length === 0) {
    return (
      <p className="mt-2 text-sm text-gray-500">
        No actions available for current status.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        {actions.map((action) => (
          <button
            key={action.target}
            onClick={() => handleTransition(action.target)}
            disabled={loading}
            className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${action.className}`}
          >
            {loading ? "..." : action.label}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
