import Link from "next/link";
import { auth } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";
import { NavLinks } from "./nav-links";

export async function Nav() {
  const session = await auth();

  if (!session?.user) return null;

  return (
    <nav className="bg-white border-b border-gray-200">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link
              href="/dashboard"
              className="text-lg font-semibold text-gray-900"
            >
              Fin-House
            </Link>
            <NavLinks />
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">
              {session.user.name}{" "}
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">
                {session.user.role}
              </span>
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
    </nav>
  );
}
