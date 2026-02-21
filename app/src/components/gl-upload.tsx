"use client";

import { useState, useRef } from "react";
import { uploadGLReport } from "@/app/actions/gl-upload";
import { useRouter } from "next/navigation";

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

export function GLUploadForm({ clientId }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
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

    const formData = new FormData();
    formData.set("clientId", clientId);
    formData.set("file", file);

    const res = await uploadGLReport(formData);
    setResult(res);
    setLoading(false);

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
    // Reset so the same file can be re-uploaded
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div>
      {/* Drop zone */}
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

      {/* Result */}
      {result && !loading && (
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
