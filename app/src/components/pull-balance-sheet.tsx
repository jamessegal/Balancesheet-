"use client";

import { useState } from "react";
import { pullBalanceSheet } from "@/app/actions/periods";
import { useRouter } from "next/navigation";

export function PullBalanceSheetButton({ periodId }: { periodId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleClick() {
    setLoading(true);
    setError(null);

    const result = await pullBalanceSheet(periodId);

    if ("error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }

    setLoading(false);
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Pulling from Xero..." : "Pull Balance Sheet"}
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
