"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createDeferredIncome,
  overrideDeferredIncomeLine,
  cancelDeferredIncome,
  deleteDeferredIncome,
} from "@/app/actions/deferred-income";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

type SpreadMethod = "equal" | "daily_proration" | "half_month";

interface DeferredIncomeRow {
  id: string;
  customerName: string;
  description: string | null;
  nominalAccount: string | null;
  startDate: string;
  endDate: string;
  totalAmount: string;
  numberOfMonths: number;
  monthlyAmount: string;
  spreadMethod?: SpreadMethod;
  status: "active" | "fully_recognised" | "cancelled";
}

interface ScheduleLine {
  id: string;
  deferredIncomeId: string;
  monthEndDate: string;
  openingBalance: string;
  monthlyRecognition: string;
  closingBalance: string;
  originalAmount: string;
  overrideAmount: string | null;
  isOverridden: boolean;
}

interface GLMovement {
  id: string;
  transactionDate: string;
  source: string | null;
  description: string | null;
  reference: string | null;
  contact: string | null;
  debit: string | null;
  credit: string | null;
}

interface Props {
  accountId: string;
  clientId: string;
  periodId: string;
  periodYear: number;
  periodMonth: number;
  accountCode: string;
  items: DeferredIncomeRow[];
  scheduleLines: ScheduleLine[];
  monthColumns: string[];
  ledgerBalances: Record<string, number>;
  closingBalance: number;
  glMovements: GLMovement[];
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function DeferredIncomeRecon({
  clientId,
  periodId,
  periodYear,
  periodMonth,
  accountCode,
  items: initialItems,
  scheduleLines,
  monthColumns,
  ledgerBalances,
  closingBalance,
  glMovements,
}: Props) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Override state
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState("");
  const [overrideNotes, setOverrideNotes] = useState("");

  // Form state
  const [customerName, setCustomerName] = useState("");
  const [description, setDescription] = useState("");
  const [nominalAccount, setNominalAccount] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [spreadMethod, setSpreadMethod] = useState<SpreadMethod>("equal");
  const formRef = useRef<HTMLDivElement>(null);

  /** Pre-fill the Add Deferred Income form from a GL movement row */
  function prefillFromMovement(movement: GLMovement) {
    setCustomerName(movement.contact || "");
    setDescription(
      [movement.description, movement.reference].filter(Boolean).join(" — ") || ""
    );
    setNominalAccount(accountCode);
    setTotalAmount(parseFloat(movement.credit || "0").toFixed(2));
    setStartDate(movement.transactionDate);
    setEndDate("");
    setSpreadMethod("equal");
    setShowForm(true);
    // Scroll to form after React re-renders
    setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  // Filter out cancelled items
  const activeItems = initialItems.filter(
    (item) => item.status !== "cancelled"
  );

  // Build a lookup: deferredIncomeId -> monthEndDate -> ScheduleLine
  const lineMap = new Map<string, Map<string, ScheduleLine>>();
  for (const line of scheduleLines) {
    if (!lineMap.has(line.deferredIncomeId)) {
      lineMap.set(line.deferredIncomeId, new Map());
    }
    lineMap.get(line.deferredIncomeId)!.set(line.monthEndDate, line);
  }

  // Calculate the viewing month end
  const viewingMonthEnd = getMonthEnd(periodYear, periodMonth);

  // Calculate totals per month column
  const monthTotals: Record<
    string,
    { totalRecognised: number; closingBalance: number }
  > = {};
  for (const month of monthColumns) {
    let totalRecognised = 0;
    let totalClosing = 0;
    for (const item of activeItems) {
      const line = lineMap.get(item.id)?.get(month);
      if (line) {
        totalRecognised += parseFloat(line.monthlyRecognition);
        totalClosing += parseFloat(line.closingBalance);
      } else {
        const allLines = scheduleLines.filter(
          (l) => l.deferredIncomeId === item.id
        );
        if (allLines.length > 0) {
          const firstLine = allLines.reduce((a, b) =>
            a.monthEndDate < b.monthEndDate ? a : b
          );
          const lastLine = allLines.reduce((a, b) =>
            a.monthEndDate > b.monthEndDate ? a : b
          );
          if (month < firstLine.monthEndDate) {
            totalClosing += parseFloat(item.totalAmount);
          } else if (month > lastLine.monthEndDate) {
            totalClosing += 0;
          }
        }
      }
    }
    monthTotals[month] = {
      totalRecognised: Math.round(totalRecognised * 100) / 100,
      closingBalance: Math.round(totalClosing * 100) / 100,
    };
  }

  // GL movements totals
  const glTotalDebit = glMovements.reduce(
    (sum, m) => sum + parseFloat(m.debit || "0"),
    0
  );
  const glTotalCredit = glMovements.reduce(
    (sum, m) => sum + parseFloat(m.credit || "0"),
    0
  );
  const glNetMovement = glTotalCredit - glTotalDebit;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!customerName.trim() || !description.trim() || !nominalAccount.trim() || !startDate || !endDate || !totalAmount) return;

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.set("clientId", clientId);
    formData.set("customerName", customerName);
    formData.set("description", description);
    formData.set("nominalAccount", nominalAccount);
    formData.set("startDate", startDate);
    formData.set("endDate", endDate);
    formData.set("totalAmount", totalAmount);
    formData.set("spreadMethod", spreadMethod);
    formData.set("periodId", periodId);

    const result = await createDeferredIncome(formData);
    if (result && "error" in result && result.error) {
      setError(result.error as string);
    } else {
      setCustomerName("");
      setDescription("");
      setNominalAccount("");
      setStartDate("");
      setEndDate("");
      setTotalAmount("");
      setSpreadMethod("equal");
      setShowForm(false);
      router.refresh();
    }
    setLoading(false);
  }

  async function handleOverride(lineId: string) {
    const val = parseFloat(overrideValue);
    if (isNaN(val) || val < 0) {
      setError("Override amount must be a non-negative number");
      return;
    }

    setLoading(true);
    setError(null);

    const result = await overrideDeferredIncomeLine(
      lineId,
      val,
      overrideNotes || null,
      periodId,
      clientId
    );

    if (result && "error" in result && result.error) {
      setError(result.error as string);
    } else {
      setEditingLine(null);
      setOverrideValue("");
      setOverrideNotes("");
      router.refresh();
    }
    setLoading(false);
  }

  async function handleCancel(deferredIncomeId: string) {
    if (!confirm("Cancel this deferred income item? It will no longer appear in the schedule.")) return;

    setLoading(true);
    const result = await cancelDeferredIncome(deferredIncomeId, periodId, clientId);
    if (result && "error" in result && result.error) {
      setError(result.error as string);
    } else {
      router.refresh();
    }
    setLoading(false);
  }

  async function handleDelete(deferredIncomeId: string) {
    if (!confirm("Permanently delete this deferred income item and all its schedule lines? This cannot be undone.")) return;

    setLoading(true);
    const result = await deleteDeferredIncome(deferredIncomeId, periodId, clientId);
    if (result && "error" in result && result.error) {
      setError(result.error as string);
    } else {
      router.refresh();
    }
    setLoading(false);
  }

  // Variance for current viewing month
  const currentMonthTotals = monthTotals[viewingMonthEnd];
  const calculatedClosing = currentMonthTotals?.closingBalance ?? 0;
  const variance = closingBalance - calculatedClosing;
  const isReconciled = Math.abs(variance) < 0.01;

  return (
    <div className="space-y-4">
      {/* Reconciliation status */}
      {activeItems.length > 0 && (
        isReconciled ? (
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
            <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-green-800">
              Reconciled — deferred income schedule matches ledger balance
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-red-800">
              Not reconciled — variance of {formatCurrency(Math.abs(variance))}
            </p>
          </div>
        )
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* GL Movements for current month */}
      {glMovements.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-3">
            <h3 className="text-sm font-medium text-gray-900">
              GL Movements — {formatMonthHeaderFull(viewingMonthEnd)}
            </h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Credit entries below relate to income received in advance this month
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Source</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Description</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Reference</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Contact</th>
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Debit</th>
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Credit</th>
                  <th className="px-3 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {glMovements.map((m) => {
                  const debit = parseFloat(m.debit || "0");
                  const credit = parseFloat(m.credit || "0");
                  return (
                    <tr key={m.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap font-mono text-xs">
                        {formatDateShort(m.transactionDate)}
                      </td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap text-xs">
                        {m.source || "-"}
                      </td>
                      <td className="px-3 py-2 text-gray-900 max-w-[16rem] truncate">
                        {m.description || "-"}
                      </td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap text-xs">
                        {m.reference || "-"}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[10rem] truncate">
                        {m.contact || "-"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                        {debit > 0 ? (
                          <span className="text-gray-900">{formatCurrencyShort(debit)}</span>
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                        {credit > 0 ? (
                          <span className="text-gray-900">{formatCurrencyShort(credit)}</span>
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {credit > 0 && (
                          <button
                            type="button"
                            onClick={() => prefillFromMovement(m)}
                            className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                          >
                            Defer Income
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr className="border-t-2 border-gray-300">
                  <td colSpan={5} className="px-3 py-2 text-sm font-semibold text-gray-900">
                    Total ({glMovements.length} transaction{glMovements.length !== 1 ? "s" : ""})
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900 whitespace-nowrap">
                    {glTotalDebit > 0 ? formatCurrencyShort(glTotalDebit) : "-"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900 whitespace-nowrap">
                    {glTotalCredit > 0 ? formatCurrencyShort(glTotalCredit) : "-"}
                  </td>
                  <td />
                </tr>
                <tr className="border-t border-gray-200">
                  <td colSpan={5} className="px-3 py-2 text-sm font-medium text-gray-700">
                    Net Movement
                  </td>
                  <td colSpan={2} className="px-3 py-2 text-right font-mono font-semibold text-gray-900 whitespace-nowrap">
                    {formatCurrencyShort(glNetMovement)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Deferred Income Schedule Grid */}
      {activeItems.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Customer / Item
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Description
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Account
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Period
                </th>
                <th className="px-3 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                  Mths
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Amount
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Opening
                </th>
                {monthColumns.map((month) => (
                  <th
                    key={month}
                    className={`px-3 py-2 text-right text-xs font-medium uppercase tracking-wider ${
                      month === viewingMonthEnd
                        ? "bg-blue-50 text-blue-700"
                        : "text-gray-500"
                    }`}
                  >
                    {formatMonthHeader(month)}
                  </th>
                ))}
                <th className="px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500 w-16">
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {activeItems.map((item, idx) => {
                const iLines = lineMap.get(item.id);
                // Opening balance for the grid = balance at start of viewing period
                const firstVisibleLine = iLines?.get(monthColumns[0]);
                const openingBal = firstVisibleLine
                  ? parseFloat(firstVisibleLine.openingBalance)
                  : (() => {
                      const allILines = scheduleLines.filter(
                        (l) => l.deferredIncomeId === item.id
                      );
                      if (allILines.length === 0) return parseFloat(item.totalAmount);
                      const firstLine = allILines.reduce((a, b) =>
                        a.monthEndDate < b.monthEndDate ? a : b
                      );
                      if (monthColumns[0] < firstLine.monthEndDate) {
                        return parseFloat(item.totalAmount);
                      }
                      return 0;
                    })();

                const rowBg = idx % 2 === 1 ? "bg-gray-50" : "bg-white";

                return (
                  <tr
                    key={item.id}
                    className={`hover:bg-blue-50/40 ${rowBg} ${
                      item.status === "fully_recognised" ? "opacity-60" : ""
                    }`}
                  >
                    <td className={`sticky left-0 z-10 ${rowBg} px-3 py-2 font-medium text-gray-900 whitespace-nowrap`}>
                      {item.customerName}
                    </td>
                    <td className="px-3 py-2 text-gray-700 max-w-[12rem] truncate">
                      {item.description || "-"}
                    </td>
                    <td className="px-3 py-2 text-gray-500 font-mono whitespace-nowrap">
                      {item.nominalAccount || "-"}
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap text-xs">
                      {formatDateShort(item.startDate)} – {formatDateShort(item.endDate)}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-500">
                      {item.numberOfMonths}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-900 whitespace-nowrap">
                      {formatCurrency(parseFloat(item.totalAmount))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-900 whitespace-nowrap">
                      {formatCurrency(openingBal)}
                    </td>
                    {monthColumns.map((month) => {
                      const line = iLines?.get(month);
                      const isCurrentMonth = month === viewingMonthEnd;
                      const isEditing = editingLine === line?.id;

                      if (!line) {
                        return (
                          <td
                            key={month}
                            className={`px-3 py-2 text-right text-gray-300 ${
                              isCurrentMonth ? "bg-blue-50/50" : ""
                            }`}
                          >
                            -
                          </td>
                        );
                      }

                      const recognition = parseFloat(line.monthlyRecognition);
                      const closing = parseFloat(line.closingBalance);

                      return (
                        <td
                          key={month}
                          className={`px-3 py-2 text-right whitespace-nowrap ${
                            isCurrentMonth ? "bg-blue-50/50" : ""
                          } ${line.isOverridden ? "bg-amber-50" : ""}`}
                        >
                          {isEditing ? (
                            <div className="flex flex-col items-end gap-1">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={overrideValue}
                                onChange={(e) => setOverrideValue(e.target.value)}
                                className="w-24 rounded border border-amber-300 px-2 py-1 text-right text-xs font-mono focus:border-amber-500 focus:outline-none"
                                autoFocus
                              />
                              <input
                                type="text"
                                value={overrideNotes}
                                onChange={(e) => setOverrideNotes(e.target.value)}
                                placeholder="Notes..."
                                className="w-24 rounded border border-gray-300 px-2 py-1 text-right text-xs focus:border-blue-500 focus:outline-none"
                              />
                              <div className="flex gap-1">
                                <button
                                  onClick={() => handleOverride(line.id)}
                                  disabled={loading}
                                  className="rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => {
                                    setEditingLine(null);
                                    setOverrideValue("");
                                    setOverrideNotes("");
                                  }}
                                  className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-300"
                                >
                                  X
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingLine(line.id);
                                setOverrideValue(
                                  line.monthlyRecognition
                                );
                                setOverrideNotes("");
                              }}
                              className="group text-right"
                              title="Click to override"
                            >
                              <div className="font-mono text-gray-900 group-hover:text-amber-700">
                                ({formatCurrencyShort(recognition)})
                                {line.isOverridden && (
                                  <span className="ml-1 text-[10px] text-amber-600">*</span>
                                )}
                              </div>
                              <div className="font-mono text-xs text-gray-500">
                                {formatCurrencyShort(closing)}
                              </div>
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleCancel(item.id)}
                          className="text-xs text-red-400 hover:text-red-600"
                          title="Cancel deferred income"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {/* Footer rows */}
            <tfoot className="bg-gray-50">
              {/* Total Recognised row */}
              <tr className="border-t-2 border-gray-300">
                <td
                  colSpan={7}
                  className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900"
                >
                  Total Recognised
                </td>
                {monthColumns.map((month) => (
                  <td
                    key={month}
                    className={`px-3 py-2 text-right font-mono font-semibold text-gray-900 whitespace-nowrap ${
                      month === viewingMonthEnd ? "bg-blue-50" : ""
                    }`}
                  >
                    ({formatCurrencyShort(monthTotals[month]?.totalRecognised ?? 0)})
                  </td>
                ))}
                <td />
              </tr>

              {/* Closing Balance row */}
              <tr className="border-t border-gray-200">
                <td
                  colSpan={7}
                  className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900"
                >
                  Closing Balance
                </td>
                {monthColumns.map((month) => (
                  <td
                    key={month}
                    className={`px-3 py-2 text-right font-mono font-semibold text-gray-900 whitespace-nowrap ${
                      month === viewingMonthEnd ? "bg-blue-50" : ""
                    }`}
                  >
                    {formatCurrencyShort(monthTotals[month]?.closingBalance ?? 0)}
                  </td>
                ))}
                <td />
              </tr>

              {/* Ledger Balance row */}
              <tr className="border-t border-gray-200">
                <td
                  colSpan={7}
                  className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700"
                >
                  Ledger Balance
                </td>
                {monthColumns.map((month) => {
                  const ledger = ledgerBalances[month];
                  return (
                    <td
                      key={month}
                      className={`px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap ${
                        month === viewingMonthEnd ? "bg-blue-50" : ""
                      }`}
                    >
                      {ledger !== undefined
                        ? formatCurrencyShort(ledger)
                        : (
                          <span className="text-gray-300">-</span>
                        )}
                    </td>
                  );
                })}
                <td />
              </tr>

              {/* Variance row */}
              <tr className="border-t border-gray-300">
                <td
                  colSpan={7}
                  className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900"
                >
                  Variance
                </td>
                {monthColumns.map((month) => {
                  const ledger = ledgerBalances[month];
                  const calculated = monthTotals[month]?.closingBalance ?? 0;
                  const monthVariance =
                    ledger !== undefined ? ledger - calculated : undefined;
                  const ok =
                    monthVariance !== undefined &&
                    Math.abs(monthVariance) < 0.01;

                  return (
                    <td
                      key={month}
                      className={`px-3 py-2 text-right font-mono font-semibold whitespace-nowrap ${
                        month === viewingMonthEnd ? "bg-blue-50" : ""
                      } ${
                        monthVariance === undefined
                          ? "text-gray-300"
                          : ok
                          ? "text-green-600"
                          : "text-red-600"
                      }`}
                    >
                      {monthVariance !== undefined ? (
                        <>
                          {formatCurrencyShort(monthVariance)}
                          {ok ? " \u2713" : ""}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                  );
                })}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
          <p className="text-sm font-medium text-gray-700">
            No deferred income items set up yet
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Use the &quot;Add Deferred Income&quot; form below to create a new recognition schedule.
            Each item will be automatically recognised across the defined period.
          </p>
          <p className="mt-2 text-xs text-gray-400">
            The closing balance to reconcile is{" "}
            <span className="font-semibold font-mono">
              {formatCurrency(closingBalance)}
            </span>
          </p>
        </div>
      )}

      {/* Add Deferred Income Form */}
      <div ref={formRef} className="rounded-lg border border-gray-200 bg-white">
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <span>Add Deferred Income</span>
          <svg
            className={`h-5 w-5 transition-transform ${showForm ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showForm && (
          <form onSubmit={handleCreate} className="border-t border-gray-200 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Customer / Item *
                </label>
                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Acme Corp or Jan Cohort"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Description *
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Annual subscription received in advance"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Account *
                </label>
                <input
                  type="text"
                  value={nominalAccount}
                  onChange={(e) => setNominalAccount(e.target.value)}
                  placeholder="e.g. 2400"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Start Date *
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  End Date *
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Total Amount *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                  placeholder="0.00"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-right font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500">
                  Spread Method *
                </label>
                <select
                  value={spreadMethod}
                  onChange={(e) => setSpreadMethod(e.target.value as SpreadMethod)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="equal">Equal monthly</option>
                  <option value="daily_proration">Daily proration</option>
                  <option value="half_month">Half-month convention</option>
                </select>
              </div>
            </div>
            {/* Spread method explanation */}
            <div className="mt-2 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
              {spreadMethod === "equal" && "Same amount recognised each month regardless of start/end dates. Last month absorbs any rounding difference."}
              {spreadMethod === "daily_proration" && "Amount split by actual days in each month. Partial first/last months receive proportionally less."}
              {spreadMethod === "half_month" && "Partial months receive half a monthly allocation. Full months receive a full allocation."}
            </div>
            {/* Preview calculation */}
            {startDate && endDate && totalAmount && new Date(endDate) > new Date(startDate) && (
              <div className="mt-3 rounded-md bg-blue-50 px-3 py-2 text-xs text-gray-700">
                {(() => {
                  const months = calcMonths(startDate, endDate);
                  const amt = parseFloat(totalAmount);
                  if (spreadMethod === "equal") {
                    const monthly = amt / months;
                    return (
                      <>
                        <span className="font-medium">{months} months</span>
                        {" | "}
                        <span className="font-mono">{formatCurrency(monthly)}/month</span>
                      </>
                    );
                  } else if (spreadMethod === "daily_proration") {
                    const preview = calcDailyPreview(startDate, endDate, amt, months);
                    return (
                      <>
                        <span className="font-medium">{months} months</span>
                        {" | "}
                        <span className="font-mono">
                          {preview.first !== preview.middle
                            ? `First: ${formatCurrency(preview.first)}, Mid: ${formatCurrency(preview.middle)}/month`
                            : `${formatCurrency(preview.middle)}/month`}
                          {preview.last !== preview.middle && `, Last: ${formatCurrency(preview.last)}`}
                        </span>
                      </>
                    );
                  } else {
                    // half_month
                    const preview = calcHalfMonthPreview(startDate, endDate, amt, months);
                    return (
                      <>
                        <span className="font-medium">{months} months ({preview.effectiveMonths} effective)</span>
                        {" | "}
                        <span className="font-mono">
                          Full: {formatCurrency(preview.full)}/month
                          {preview.hasPartialFirst && `, First: ${formatCurrency(preview.half)}`}
                          {preview.hasPartialLast && `, Last: ${formatCurrency(preview.half)}`}
                        </span>
                      </>
                    );
                  }
                })()}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Creating..." : "Create Deferred Income"}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Cancelled items (collapsed) */}
      {initialItems.filter((item) => item.status === "cancelled").length > 0 && (
        <details className="rounded-lg border border-gray-200 bg-white">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-500 hover:bg-gray-50">
            Cancelled Deferred Income (
            {initialItems.filter((item) => item.status === "cancelled").length}
            )
          </summary>
          <div className="border-t border-gray-200 p-4">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Customer / Item
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Description
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase text-gray-500">
                    Amount
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium uppercase text-gray-500 w-20">
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {initialItems
                  .filter((item) => item.status === "cancelled")
                  .map((item) => (
                    <tr key={item.id} className="opacity-60">
                      <td className="px-3 py-2 text-gray-900">
                        {item.customerName}
                      </td>
                      <td className="px-3 py-2 text-gray-500">
                        {item.description || "-"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-900">
                        {formatCurrency(parseFloat(item.totalAmount))}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="text-xs text-red-400 hover:text-red-600"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function getMonthEnd(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function calcMonths(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth()) +
    1
  );
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatCurrencyShort(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatMonthHeader(monthEndDate: string): string {
  const d = new Date(monthEndDate + "T00:00:00");
  const day = d.getDate();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  return `${String(day).padStart(2, "0")}/${month}/${year}`;
}

function formatMonthHeaderFull(monthEndDate: string): string {
  const d = new Date(monthEndDate + "T00:00:00");
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
}

/** Preview for daily proration spread. Returns first, middle, and last month amounts. */
function calcDailyPreview(
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number
): { first: number; middle: number; last: number } {
  const start = new Date(startDate);
  const end = new Date(endDate);

  function daysInMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
  }

  const monthDays: number[] = [];
  let curYear = start.getFullYear();
  let curMonth = start.getMonth() + 1;

  for (let i = 0; i < numberOfMonths; i++) {
    const totalDays = daysInMonth(curYear, curMonth);
    let days: number;
    if (i === 0 && i === numberOfMonths - 1) {
      days = end.getDate() - start.getDate() + 1;
    } else if (i === 0) {
      days = totalDays - start.getDate() + 1;
    } else if (i === numberOfMonths - 1) {
      days = end.getDate();
    } else {
      days = totalDays;
    }
    monthDays.push(Math.max(days, 0));
    curMonth++;
    if (curMonth > 12) { curMonth = 1; curYear++; }
  }

  const totalDays = monthDays.reduce((a, b) => a + b, 0);
  const first = Math.round((totalAmount * monthDays[0] / totalDays) * 100) / 100;
  const last = Math.round((totalAmount * monthDays[monthDays.length - 1] / totalDays) * 100) / 100;
  const midIdx = numberOfMonths > 2 ? 1 : 0;
  const middle = Math.round((totalAmount * monthDays[midIdx] / totalDays) * 100) / 100;

  return { first, middle, last };
}

/** Preview for half-month convention. */
function calcHalfMonthPreview(
  startDate: string,
  endDate: string,
  totalAmount: number,
  numberOfMonths: number
): { full: number; half: number; effectiveMonths: number; hasPartialFirst: boolean; hasPartialLast: boolean } {
  const start = new Date(startDate);
  const end = new Date(endDate);

  function daysInMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
  }

  const hasPartialFirst = start.getDate() > 1;
  const lastDayOfEndMonth = daysInMonth(end.getFullYear(), end.getMonth() + 1);
  const hasPartialLast = numberOfMonths > 1 && end.getDate() < lastDayOfEndMonth;

  let effectiveMonths = 0;
  for (let i = 0; i < numberOfMonths; i++) {
    if (i === 0 && hasPartialFirst) {
      effectiveMonths += 0.5;
    } else if (i === numberOfMonths - 1 && hasPartialLast) {
      effectiveMonths += 0.5;
    } else {
      effectiveMonths += 1;
    }
  }

  const perUnit = totalAmount / effectiveMonths;
  return {
    full: Math.round(perUnit * 100) / 100,
    half: Math.round((perUnit * 0.5) * 100) / 100,
    effectiveMonths,
    hasPartialFirst,
    hasPartialLast,
  };
}
