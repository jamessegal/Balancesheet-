"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchAgedReceivables,
  updateInvoiceComment,
  updateInvoiceRiskFlag,
  toggleInvoiceReviewed,
  bulkMarkBucketReviewed,
  markARReconComplete,
  reopenARRecon,
} from "@/app/actions/ar-recon";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";
type RiskFlag = "none" | "watch" | "high";

interface ReconData {
  id: string;
  monthEndDate: string;
  ledgerBalance: string;
  agedReportTotal: string | null;
  variance: string | null;
  status: string;
  signedOffByName: string | null;
  signedOffAt: Date | null;
}

interface InvoiceRow {
  id: string;
  xeroInvoiceId: string | null;
  invoiceNumber: string | null;
  contactName: string;
  invoiceDate: string | null;
  dueDate: string | null;
  originalAmount: string;
  outstandingAmount: string;
  agingBucket: string;
  daysOverdue: number;
  requiresComment: boolean;
  commentText: string | null;
  riskFlag: string;
  reviewed: boolean;
}

interface Props {
  accountId: string;
  glBalance: number;
  monthEndDate: string;
  periodYear: number;
  periodMonth: number;
  recon: ReconData | null;
  invoices: InvoiceRow[];
}

const BUCKET_ORDER: AgingBucket[] = [
  "current",
  "1_30",
  "31_60",
  "61_90",
  "90_plus",
];

const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Current",
  "1_30": "1–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  "90_plus": "90+ days",
};

const BUCKET_COLORS: Record<
  AgingBucket,
  { bg: string; text: string; border: string; badge: string }
> = {
  current: {
    bg: "bg-green-50",
    text: "text-green-700",
    border: "border-green-200",
    badge: "bg-green-100 text-green-700",
  },
  "1_30": {
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    badge: "bg-blue-100 text-blue-700",
  },
  "31_60": {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    badge: "bg-amber-100 text-amber-700",
  },
  "61_90": {
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    badge: "bg-orange-100 text-orange-700",
  },
  "90_plus": {
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
    badge: "bg-red-100 text-red-700",
  },
};

const RISK_OPTIONS: { value: RiskFlag; label: string; className: string }[] = [
  { value: "none", label: "None", className: "text-gray-500" },
  { value: "watch", label: "Watch", className: "text-amber-600" },
  { value: "high", label: "High", className: "text-red-600" },
];

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function ARRecon({
  accountId,
  glBalance,
  monthEndDate: meDate,
  periodYear,
  periodMonth,
  recon,
  invoices,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [savingComment, setSavingComment] = useState(false);
  const [showCurrentBucket, setShowCurrentBucket] = useState(false);

  const hasData = recon && invoices.length > 0;
  const agedTotal = recon?.agedReportTotal
    ? parseFloat(recon.agedReportTotal)
    : invoices.reduce((sum, inv) => sum + parseFloat(inv.outstandingAmount), 0);
  const variance = recon?.variance ? parseFloat(recon.variance) : glBalance - agedTotal;
  const isZeroVariance = Math.abs(variance) < 0.005;
  const isComplete = recon?.status === "complete" || recon?.status === "reviewed";

  // Bucket summaries
  const bucketTotals: Record<AgingBucket, { count: number; total: number }> = {
    current: { count: 0, total: 0 },
    "1_30": { count: 0, total: 0 },
    "31_60": { count: 0, total: 0 },
    "61_90": { count: 0, total: 0 },
    "90_plus": { count: 0, total: 0 },
  };

  for (const inv of invoices) {
    const bucket = inv.agingBucket as AgingBucket;
    if (bucketTotals[bucket]) {
      bucketTotals[bucket].count++;
      bucketTotals[bucket].total += parseFloat(inv.outstandingAmount);
    }
  }

  // Validation: count 90+ without comments
  const uncommented90Plus = invoices.filter(
    (inv) =>
      inv.agingBucket === "90_plus" && !inv.commentText?.trim()
  ).length;

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  async function handleFetchFromXero() {
    setLoading(true);
    setError(null);

    const result = await fetchAgedReceivables(accountId);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setLoading(false);
  }

  async function handleSaveComment(snapshotId: string) {
    setSavingComment(true);
    setError(null);

    const result = await updateInvoiceComment(snapshotId, commentDraft);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      setEditingComment(null);
      setCommentDraft("");
      router.refresh();
    }
    setSavingComment(false);
  }

  async function handleRiskFlagChange(
    snapshotId: string,
    flag: RiskFlag
  ) {
    const result = await updateInvoiceRiskFlag(snapshotId, flag);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
  }

  async function handleToggleReviewed(
    snapshotId: string,
    current: boolean
  ) {
    const result = await toggleInvoiceReviewed(snapshotId, !current);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
  }

  async function handleBulkReview(bucket: AgingBucket) {
    if (!recon) return;
    setLoading(true);
    const result = await bulkMarkBucketReviewed(recon.id, bucket);
    if (result && "error" in result && result.error) {
      setError(result.error as string);
    } else {
      router.refresh();
    }
    setLoading(false);
  }

  async function handleMarkComplete() {
    if (!recon) return;
    setLoading(true);
    setError(null);

    const result = await markARReconComplete(recon.id);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    setLoading(false);
  }

  async function handleReopen() {
    if (!recon) return;
    setLoading(true);
    const result = await reopenARRecon(recon.id);
    if (result && "error" in result && result.error) {
      setError(result.error as string);
    } else {
      router.refresh();
    }
    setLoading(false);
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Status banner */}
      {isComplete && (
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
            Reconciliation complete — aged debtors matches ledger balance
          </p>
          {recon?.signedOffByName && (
            <span className="ml-auto text-xs text-green-600">
              Signed off by {recon.signedOffByName}
              {recon.signedOffAt &&
                ` on ${new Date(recon.signedOffAt).toLocaleDateString("en-GB")}`}
            </span>
          )}
        </div>
      )}

      {hasData && !isComplete && !isZeroVariance && (
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
            {formatAmount(Math.abs(variance))}
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Top Summary Section */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Receivables Summary
        </h3>
        <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <tbody className="divide-y divide-gray-200">
              <tr>
                <td className="px-4 py-3 text-sm text-gray-500">Month End</td>
                <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">
                  {formatDateGB(meDate)}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  Ledger Balance (Xero)
                </td>
                <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                  {formatAmount(glBalance)}
                </td>
              </tr>
              {hasData && (
                <>
                  <tr>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      Aged Debtors Total
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono font-medium text-gray-900">
                      {formatAmount(agedTotal)}
                    </td>
                  </tr>
                  <tr className={isZeroVariance ? "bg-green-50" : "bg-red-50"}>
                    <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                      Variance
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-sm font-mono font-semibold ${
                        isZeroVariance ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {formatAmount(variance)}
                      {isZeroVariance ? " \u2713" : ""}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fetch from Xero button */}
      {!isComplete && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleFetchFromXero}
            disabled={loading}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading
              ? "Fetching..."
              : hasData
                ? "Refresh from Xero"
                : "Pull Aged Debtors from Xero"}
          </button>
          {hasData && (
            <span className="text-xs text-gray-400">
              {invoices.length} invoice{invoices.length !== 1 ? "s" : ""}{" "}
              loaded
            </span>
          )}
        </div>
      )}

      {/* Aging Summary Cards */}
      {hasData && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Aging Summary
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {BUCKET_ORDER.map((bucket) => {
              const colors = BUCKET_COLORS[bucket];
              const data = bucketTotals[bucket];
              return (
                <div
                  key={bucket}
                  className={`rounded-lg border ${colors.border} ${colors.bg} p-3`}
                >
                  <p className={`text-xs font-medium ${colors.text}`}>
                    {BUCKET_LABELS[bucket]}
                  </p>
                  <p
                    className={`mt-1 text-lg font-semibold font-mono ${colors.text}`}
                  >
                    {formatAmount(data.total)}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {data.count} invoice{data.count !== 1 ? "s" : ""}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Invoice Table */}
      {hasData && (
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
              Invoice Detail
            </h3>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={showCurrentBucket}
                  onChange={(e) => setShowCurrentBucket(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-300"
                />
                Show current invoices
              </label>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Customer
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Invoice #
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Inv Date
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Due Date
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Outstanding
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                    Days O/D
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                    Bucket
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500 min-w-[200px]">
                    Comment
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                    Risk
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                    Reviewed
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {BUCKET_ORDER.map((bucket) => {
                  const bucketInvoices = invoices.filter(
                    (inv) => inv.agingBucket === bucket
                  );
                  if (bucketInvoices.length === 0) return null;

                  // Hide current bucket by default
                  if (bucket === "current" && !showCurrentBucket) {
                    return (
                      <tr key={bucket} className="bg-gray-50">
                        <td
                          colSpan={10}
                          className="px-3 py-2 text-center text-xs text-gray-400"
                        >
                          {bucketInvoices.length} current invoice
                          {bucketInvoices.length !== 1 ? "s" : ""} hidden (
                          {formatAmount(bucketTotals.current.total)}) —{" "}
                          <button
                            onClick={() => setShowCurrentBucket(true)}
                            className="text-blue-600 hover:underline"
                          >
                            show
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  return bucketInvoices.map((inv) => {
                    const bColors =
                      BUCKET_COLORS[inv.agingBucket as AgingBucket];
                    const isHighBalance =
                      parseFloat(inv.outstandingAmount) > 10000 &&
                      inv.daysOverdue > 30;
                    const isEditing = editingComment === inv.id;

                    return (
                      <tr
                        key={inv.id}
                        className={`hover:bg-gray-50 ${
                          inv.reviewed ? "opacity-60" : ""
                        } ${isHighBalance && !inv.reviewed ? "bg-red-50/30" : ""}`}
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-900">
                          {inv.contactName}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-gray-700">
                          {inv.invoiceNumber || "-"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                          {inv.invoiceDate
                            ? formatDateGB(inv.invoiceDate)
                            : "-"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                          {inv.dueDate ? formatDateGB(inv.dueDate) : "-"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-gray-900">
                          {formatAmount(parseFloat(inv.outstandingAmount))}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center">
                          <span
                            className={
                              inv.daysOverdue > 90
                                ? "font-semibold text-red-600"
                                : inv.daysOverdue > 60
                                  ? "font-medium text-orange-600"
                                  : inv.daysOverdue > 30
                                    ? "text-amber-600"
                                    : "text-gray-500"
                            }
                          >
                            {inv.daysOverdue > 0 ? inv.daysOverdue : "-"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${bColors.badge}`}
                          >
                            {
                              BUCKET_LABELS[
                                inv.agingBucket as AgingBucket
                              ]
                            }
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={commentDraft}
                                onChange={(e) =>
                                  setCommentDraft(e.target.value)
                                }
                                placeholder="Enter comment..."
                                className="w-full min-w-[160px] rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    handleSaveComment(inv.id);
                                  }
                                  if (e.key === "Escape") {
                                    setEditingComment(null);
                                    setCommentDraft("");
                                  }
                                }}
                                disabled={isComplete}
                              />
                              <button
                                onClick={() => handleSaveComment(inv.id)}
                                disabled={savingComment || isComplete}
                                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                              >
                                {savingComment ? "..." : "Save"}
                              </button>
                              <button
                                onClick={() => {
                                  setEditingComment(null);
                                  setCommentDraft("");
                                }}
                                className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-300"
                              >
                                X
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                if (isComplete) return;
                                setEditingComment(inv.id);
                                setCommentDraft(inv.commentText || "");
                              }}
                              className={`w-full text-left text-xs ${
                                isComplete
                                  ? "cursor-default"
                                  : "cursor-pointer hover:text-blue-600"
                              } ${
                                inv.commentText
                                  ? "text-gray-700"
                                  : inv.requiresComment
                                    ? "italic text-red-400"
                                    : "text-gray-300"
                              }`}
                              disabled={isComplete}
                            >
                              {inv.commentText ||
                                (inv.requiresComment
                                  ? "Comment required"
                                  : inv.agingBucket === "61_90"
                                    ? "Recommended"
                                    : "Click to add")}
                            </button>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center">
                          <select
                            value={inv.riskFlag}
                            onChange={(e) =>
                              handleRiskFlagChange(
                                inv.id,
                                e.target.value as RiskFlag
                              )
                            }
                            disabled={isComplete}
                            className={`rounded border border-gray-200 px-1.5 py-0.5 text-xs ${
                              inv.riskFlag === "high"
                                ? "bg-red-50 text-red-700"
                                : inv.riskFlag === "watch"
                                  ? "bg-amber-50 text-amber-700"
                                  : "text-gray-500"
                            } ${isComplete ? "cursor-default opacity-60" : ""}`}
                          >
                            {RISK_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={inv.reviewed}
                            onChange={() =>
                              handleToggleReviewed(inv.id, inv.reviewed)
                            }
                            disabled={isComplete}
                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr className="border-t-2 border-gray-300">
                  <td
                    colSpan={4}
                    className="px-3 py-2 text-sm font-semibold text-gray-900"
                  >
                    Total ({invoices.length} invoices)
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-mono font-semibold text-gray-900">
                    {formatAmount(agedTotal)}
                  </td>
                  <td colSpan={5} />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Bulk review actions */}
          {!isComplete && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">
                Bulk mark reviewed:
              </span>
              {BUCKET_ORDER.map((bucket) => {
                const data = bucketTotals[bucket];
                if (data.count === 0) return null;
                const allReviewed = invoices
                  .filter((inv) => inv.agingBucket === bucket)
                  .every((inv) => inv.reviewed);
                if (allReviewed) return null;

                return (
                  <button
                    key={bucket}
                    onClick={() => handleBulkReview(bucket)}
                    disabled={loading}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${BUCKET_COLORS[bucket].badge} hover:opacity-80 disabled:opacity-50`}
                  >
                    {BUCKET_LABELS[bucket]} ({data.count})
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Mark complete / Reopen */}
      {hasData && (
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
          {isComplete ? (
            <>
              <span className="text-sm text-green-700 font-medium">
                Reconciliation complete
              </span>
              <button
                onClick={handleReopen}
                disabled={loading}
                className="ml-auto rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Reopen
              </button>
            </>
          ) : (
            <>
              <div className="flex-1">
                {!isZeroVariance && (
                  <p className="text-xs text-red-600">
                    Cannot complete: variance must be zero
                  </p>
                )}
                {isZeroVariance && uncommented90Plus > 0 && (
                  <p className="text-xs text-red-600">
                    Cannot complete: {uncommented90Plus} invoice
                    {uncommented90Plus !== 1 ? "s" : ""} over 90 days
                    require comments
                  </p>
                )}
                {isZeroVariance && uncommented90Plus === 0 && (
                  <p className="text-xs text-green-600">
                    All validation checks passed. Ready to complete.
                  </p>
                )}
              </div>
              <button
                onClick={handleMarkComplete}
                disabled={
                  loading ||
                  !isZeroVariance ||
                  uncommented90Plus > 0
                }
                className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {loading ? "Saving..." : "Mark Complete"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasData && (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm font-medium text-gray-700">
            No aged debtors data loaded
          </p>
          <p className="mt-1 text-xs text-gray-500">
            The GL balance from Xero is{" "}
            <span className="font-semibold font-mono">
              {formatAmount(glBalance)}
            </span>
            . Click &quot;Pull Aged Debtors from Xero&quot; to fetch
            outstanding invoices as at{" "}
            {formatDateGB(meDate)}.
          </p>
          <p className="mt-3 text-xs text-gray-400">
            This will retrieve all ACCREC invoices that were outstanding as at{" "}
            {formatDateGB(meDate)}, including invoices since paid,
            and calculate aging buckets based on due dates.
          </p>
        </div>
      )}

      {/* Xero API note */}
      {hasData && (
        <div className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-400">
          <strong>Note:</strong> Outstanding amounts reflect point-in-time
          balances as at {formatDateGB(meDate)}, calculated from
          invoice totals minus payments received on or before that date.
          Invoices paid since month end are included at their month-end
          balance. Credit note allocations dated after month end may need
          manual verification.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function formatAmount(amount: number): string {
  const formatted = Math.abs(amount).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0
    ? `(\u00A3${formatted})`
    : `\u00A3${formatted}`;
}

function formatDateGB(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
