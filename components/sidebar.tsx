"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavLink } from "@/components/nav-link";
import { useApi } from "@/lib/api";

const FULL_NAV = [
  { label: "Discover", href: "/discover" },
  { label: "Dashboard", href: "/" },
  { label: "Series", href: "/series" },
  { label: "Movies", href: "/movies" },
  { label: "Add New", href: "/add" },
  { label: "Requests", href: "/requests" },
  { label: "Wanted", href: "/wanted" },
  { label: "Queue", href: "/activity/queue" },
  { label: "History", href: "/activity/history" },
] as const;

const USER_NAV = [
  { label: "Discover", href: "/discover" },
  { label: "Series", href: "/series" },
  { label: "Movies", href: "/movies" },
  { label: "Requests", href: "/requests" },
] as const;

const SETTINGS_NAV = [
  { label: "Media Management", href: "/settings/media-management" },
  { label: "Library Import", href: "/settings/library-import" },
  { label: "Profiles", href: "/settings/profiles" },
  { label: "Indexers", href: "/settings/indexers" },
  { label: "Download Clients", href: "/settings/download-clients" },
  { label: "Migrate", href: "/settings/migrate" },
  { label: "General", href: "/settings/general" },
  { label: "Tasks", href: "/system/tasks" },
] as const;

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

export function Sidebar() {
  const router = useRouter();
  const { data: me } = useApi<Me>("/auth/me");
  const isAdmin = me?.role === "admin";
  const nav = isAdmin ? FULL_NAV : USER_NAV;

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col gap-6 overflow-y-auto border-r border-zinc-800 bg-zinc-900/60 p-4">
      <Link href="/" className="text-lg font-semibold tracking-tight text-amber-400">
        media-box
      </Link>
      <nav className="flex flex-col gap-1">
        {nav.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} />
        ))}
      </nav>
      {isAdmin && (
        <div>
          <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Settings
          </div>
          <nav className="flex flex-col gap-1">
            {SETTINGS_NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </nav>
        </div>
      )}
      <div className="mt-auto border-t border-zinc-800 pt-3 text-sm">
        {me && (
          <div className="flex items-center justify-between px-2">
            <span className="truncate text-zinc-400">{me.username}</span>
            <button onClick={logout} className="text-xs text-zinc-500 hover:text-amber-300">
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
