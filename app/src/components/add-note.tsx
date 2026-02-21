"use client";

import { useState } from "react";
import { addNote } from "@/app/actions/account-detail";
import { useRouter } from "next/navigation";

export function AddNoteForm({ accountId }: { accountId: string }) {
  const [content, setContent] = useState("");
  const [noteType, setNoteType] = useState("prep");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("noteType", noteType);
    formData.set("content", content);

    const result = await addNote(formData);

    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      setContent("");
      router.refresh();
    }

    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex gap-2 mb-3">
        {(["prep", "review", "general"] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setNoteType(type)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              noteType === type
                ? type === "prep"
                  ? "bg-blue-600 text-white"
                  : type === "review"
                    ? "bg-purple-600 text-white"
                    : "bg-gray-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {type === "prep" ? "Prep" : type === "review" ? "Review" : "General"}
          </button>
        ))}
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Add a note..."
        rows={3}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mt-2 flex items-center justify-between">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading || !content.trim()}
          className="ml-auto rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Adding..." : "Add Note"}
        </button>
      </div>
    </form>
  );
}
