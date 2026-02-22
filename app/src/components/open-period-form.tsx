"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createPeriod } from "@/app/actions/periods";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  clientId: string;
  availableMonths: { year: number; month: number }[];
}

export function OpenPeriodForm({ clientId, availableMonths }: Props) {
  const [selected, setSelected] = useState(
    `${availableMonths[0].year}-${availableMonths[0].month}`
  );
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const [year, month] = selected.split("-");
    const formData = new FormData();
    formData.set("clientId", clientId);
    formData.set("year", year);
    formData.set("month", month);

    await createPeriod(formData);
    router.refresh();
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {availableMonths.map(({ year, month }) => (
          <option key={`${year}-${month}`} value={`${year}-${month}`}>
            {MONTH_NAMES[month - 1]} {year}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Opening..." : "Open Period"}
      </button>
    </form>
  );
}
