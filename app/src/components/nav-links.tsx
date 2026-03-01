"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavLinksProps {
  isAdmin?: boolean;
}

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
];

const ADMIN_ITEMS = [
  { href: "/admin/users", label: "Users" },
];

export function NavLinks({ isAdmin }: NavLinksProps) {
  const pathname = usePathname();
  const items = isAdmin ? [...NAV_ITEMS, ...ADMIN_ITEMS] : NAV_ITEMS;

  return (
    <div className="flex items-center gap-4">
      {items.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`text-sm ${
              isActive
                ? "font-medium text-gray-900 border-b-2 border-blue-600 pb-0.5"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
