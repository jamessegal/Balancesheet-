"use client";

import { useState } from "react";
import { createClient } from "@/app/actions/clients";
import Link from "next/link";

export default function NewClientPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError(null);
    const result = await createClient(formData);
    if (result?.error) {
      setError(result.error);
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6">
        <Link
          href="/clients"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          &larr; Back to clients
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">Add Client</h1>
      <p className="mt-1 text-sm text-gray-500">
        Create a new client record
      </p>

      {error && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form action={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label
            htmlFor="name"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Client Name *
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="e.g. Acme Ltd"
          />
        </div>

        <div>
          <label
            htmlFor="code"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Client Code *
          </label>
          <input
            id="code"
            name="code"
            type="text"
            required
            maxLength={50}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm uppercase focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="e.g. ACME"
          />
          <p className="mt-1 text-xs text-gray-400">
            Short unique identifier. Will be uppercased.
          </p>
        </div>

        <div>
          <label
            htmlFor="contactName"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Contact Name
          </label>
          <input
            id="contactName"
            name="contactName"
            type="text"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label
            htmlFor="contactEmail"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Contact Email
          </label>
          <input
            id="contactEmail"
            name="contactEmail"
            type="email"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label
            htmlFor="notes"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create Client"}
          </button>
          <Link
            href="/clients"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
