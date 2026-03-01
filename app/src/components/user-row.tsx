"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateUserRole, resetUserPassword, deleteUser } from "@/app/actions/user-management";

interface UserRowProps {
  user: {
    id: string;
    name: string;
    email: string;
    role: "admin" | "manager" | "junior";
    createdAt: Date;
  };
}

const ROLE_BADGES: Record<string, string> = {
  admin: "bg-purple-100 text-purple-700",
  manager: "bg-blue-100 text-blue-700",
  junior: "bg-gray-100 text-gray-700",
};

export function UserRow({ user }: UserRowProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [newRole, setNewRole] = useState(user.role);
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleRoleChange() {
    setLoading(true);
    setError(null);
    const result = await updateUserRole(user.id, newRole);
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      setEditing(false);
      router.refresh();
    }
  }

  async function handlePasswordReset() {
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    setError(null);
    const result = await resetUserPassword(user.id, newPassword);
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      setResetting(false);
      setNewPassword("");
    }
  }

  async function handleDelete() {
    setLoading(true);
    setError(null);
    const result = await deleteUser(user.id);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      setConfirmDelete(false);
    } else {
      router.refresh();
    }
  }

  return (
    <>
      <tr className="hover:bg-gray-50">
        <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
          {user.name}
        </td>
        <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
          {user.email}
        </td>
        <td className="whitespace-nowrap px-6 py-4 text-sm">
          {editing ? (
            <div className="flex items-center gap-2">
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as "admin" | "manager" | "junior")}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm"
              >
                <option value="junior">Junior</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={handleRoleChange}
                disabled={loading}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Save
              </button>
              <button
                onClick={() => { setEditing(false); setError(null); }}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${ROLE_BADGES[user.role] || ROLE_BADGES.junior}`}>
              {user.role}
            </span>
          )}
        </td>
        <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
          {new Date(user.createdAt).toLocaleDateString("en-GB")}
        </td>
        <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
          <div className="flex items-center justify-end gap-3">
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                className="text-blue-600 hover:text-blue-800"
              >
                Edit Role
              </button>
            )}
            <button
              onClick={() => setResetting(!resetting)}
              className="text-gray-600 hover:text-gray-800"
            >
              {resetting ? "Cancel" : "Reset Password"}
            </button>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-red-600 hover:text-red-800"
              >
                Delete
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600">Are you sure?</span>
                <button
                  onClick={handleDelete}
                  disabled={loading}
                  className="text-sm font-medium text-red-600 hover:text-red-800"
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-sm text-gray-500"
                >
                  No
                </button>
              </div>
            )}
          </div>
        </td>
      </tr>
      {/* Inline password reset row */}
      {resetting && (
        <tr className="bg-gray-50">
          <td colSpan={5} className="px-6 py-3">
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600">New password for {user.name}:</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                placeholder="Min 8 characters"
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
              <button
                onClick={handlePasswordReset}
                disabled={loading}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Resetting..." : "Reset"}
              </button>
            </div>
          </td>
        </tr>
      )}
      {/* Error row */}
      {error && (
        <tr className="bg-red-50">
          <td colSpan={5} className="px-6 py-2">
            <p className="text-sm text-red-700">{error}</p>
          </td>
        </tr>
      )}
    </>
  );
}
