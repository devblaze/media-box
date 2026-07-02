"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={`rounded px-2 py-1.5 text-sm transition-colors ${
        active ? "bg-amber-500/15 text-amber-300" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}
