"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-4">
      {NAV_ITEMS.map((item) => {
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
