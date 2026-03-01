"use client";

import { useState, useRef } from "react";
import { uploadGLReport, previewGLReupload } from "@/app/actions/gl-upload";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "./confirm-dialog";
import { formatCurrency } from "@/lib/format";

interface Props {
  clientId: string;
}

interface UploadResult {
  success?: boolean;
  error?: string;
  rowCount?: number;
  accountCount?: number;
  dateFrom?: string | null;
  dateTo?: string | null;
  accounts?: string[];
}

interface DiffChange {
  accountName: string;
  changeType: "added" | "removed" | "modified";
  oldTxnCount: number;
  newTxnCount: number;
  oldTotal: number;
  newTotal: number;
}

interface ReuploadPreview {
  isReupload?: boolean;
  isFirstUpload?: boolean;
  error?: string;
  priorFileName?: string;
  priorRowCount?: number;
  priorAccountCount?: number;
  newRowCount?: number;
  newAccountCount?: number;
  newDateFrom?: string | null;
  newDateTo?: string | null;
  changes?: DiffChange[];
  unchangedCount?: number;
}

export function GLUploadForm({ clientId }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<ReuploadPreview | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleFile(file: File) {
    if (
      !file.name.endsWith(".xlsx") &&
      !file.name.endsWith(".xls") &&
      !file.name.endsWith(".csv")
    ) {
      setResult({ error: "Please upload an Excel file (.xlsx or .xls)" });
      return;
    }

    setLoading(true);
    setResult(null);
    setPreview(null);

    // First, check if this is a re-upload and get the diff
    const formData = new FormData();
    formData.set("clientId", clientId);
    formData.set("file", file);

    const previewResult = await previewGLReupload(formData) as ReuploadPreview;

    if (previewResult.error) {
      setResult({ error: previewResult.error });
      setLoading(false);
      return;
    }

    if (previewResult.isReupload) {
      // Show diff and ask for confirmation
      setPreview(previewResult);
      setPendingFile(file);
      setLoading(false);
      return;
    }

    // First upload — proceed directly
    await doUpload(file);
  }

  async function doUpload(file: File) {
    setLoading(true);
    setPreview(null);

    const formData = new FormData();
    formData.set("clientId", clientId);
    formData.set("file", file);

    const res = await uploadGLReport(formData);
    setResult(res);
    setLoading(false);
    setPendingFile(null);

    if (res.success) {
      router.refresh();
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  const changeTypeColors = {
    added: "text-green-700 bg-green-50",
    removed: "text-red-700 bg-red-50",
    modified: "text-amber-700 bg-amber-50",
  };

  return (
    <div>
      {/* Re-upload diff warning */}
      {preview?.isReupload && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-medium text-amber-800">
            Re-upload detected — review changes before proceeding
          </h3>
          <div className="mt-2 grid grid-cols-2 gap-4 text-sm text-amber-700">
            <div>
              <span className="font-medium">Previous:</span>{" "}
              {preview.priorFileName} ({preview.priorRowCount?.toLocaleString()} txns, {preview.priorAccountCount} accounts)
            </div>
            <div>
              <span className="font-medium">New:</span>{" "}
              {preview.newRowCount?.toLocaleString()} txns, {preview.newAccountCount} accounts
              {preview.newDateFrom && preview.newDateTo && (
                <span className="ml-1">({preview.newDateFrom} to {preview.newDateTo})</span>
              )}
            </div>
          </div>

          {preview.changes && preview.changes.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-medium text-amber-800">
                {preview.changes.length} account{preview.changes.length !== 1 ? "s" : ""} changed,{" "}
                {preview.unchangedCount} unchanged
              </p>
              <div className="mt-2 max-h-48 overflow-y-auto rounded border border-amber-200 bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium text-gray-600">Account</th>
                      <th className="px-3 py-1.5 text-left font-medium text-gray-600">Change</th>
                      <th className="px-3 py-1.5 text-right font-medium text-gray-600">Old Txns</th>
                      <th className="px-3 py-1.5 text-right font-medium text-gray-600">New Txns</th>
                      <th className="px-3 py-1.5 text-right font-medium text-gray-600">Old Net</th>
                      <th className="px-3 py-1.5 text-right font-medium text-gray-600">New Net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preview.changes.map((c) => (
                      <tr key={c.accountName} className={changeTypeColors[c.changeType]}>
                        <td className="px-3 py-1.5 font-medium">{c.accountName}</td>
                        <td className="px-3 py-1.5 capitalize">{c.changeType}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{c.oldTxnCount}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{c.newTxnCount}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatCurrency(c.oldTotal)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatCurrency(c.newTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-amber-700">
              No per-account changes detected (row counts/amounts may differ).
            </p>
          )}

          <div className="mt-4 flex gap-3">
            <button
              onClick={() => pendingFile && doUpload(pendingFile)}
              disabled={loading}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {loading ? "Uploading..." : "Proceed with Re-upload"}
            </button>
            <button
              onClick={() => {
                setPreview(null);
                setPendingFile(null);
              }}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Drop zone */}
      {!preview?.isReupload && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragOver
              ? "border-blue-400 bg-blue-50"
              : "border-gray-300 bg-white hover:border-gray-400"
          }`}
        >
          {loading ? (
            <div>
              <p className="text-sm font-medium text-gray-700">
                Parsing and uploading...
              </p>
              <p className="mt-1 text-xs text-gray-500">
                This may take a moment for large files.
              </p>
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium text-gray-700">
                Drop a Xero General Ledger export here
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Excel format (.xlsx). Download from Xero: Reports &rarr; General
                Ledger (Detailed) &rarr; Export
              </p>
              <label className="mt-3 inline-flex cursor-pointer items-center rounded-md bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50">
                Choose file
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleChange}
                  className="sr-only"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {/* Result */}
      {result && !loading && !preview?.isReupload && (
        <div
          className={`mt-4 rounded-lg border p-4 ${
            result.error
              ? "border-red-200 bg-red-50"
              : "border-green-200 bg-green-50"
          }`}
        >
          {result.error ? (
            <p className="text-sm text-red-700">{result.error}</p>
          ) : (
            <div>
              <p className="text-sm font-medium text-green-800">
                Uploaded successfully
              </p>
              <div className="mt-2 text-sm text-green-700">
                <p>
                  {result.rowCount?.toLocaleString()} transactions across{" "}
                  {result.accountCount} accounts
                </p>
                {result.dateFrom && result.dateTo && (
                  <p>
                    Date range: {result.dateFrom} to {result.dateTo}
                  </p>
                )}
              </div>
              {result.accounts && result.accounts.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-green-600 hover:text-green-800">
                    Show {result.accounts.length} accounts
                  </summary>
                  <ul className="mt-1 max-h-40 overflow-y-auto text-xs text-green-700">
                    {result.accounts.map((a) => (
                      <li key={a} className="py-0.5">
                        {a}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
