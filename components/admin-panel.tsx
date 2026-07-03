"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

/** Management nav for the admin panel. Order mirrors the settings/system routes. */
const NAV = [
  { label: "Dashboard", href: "/settings" },
  { label: "Requests", href: "/settings/requests" },
  { label: "Users", href: "/settings/users" },
  { label: "Media Management", href: "/settings/media-management" },
  { label: "Monitoring", href: "/settings/monitoring" },
  { label: "Quality Profiles", href: "/settings/profiles" },
  { label: "Subtitles", href: "/settings/subtitles" },
  { label: "Indexers", href: "/settings/indexers" },
  { label: "Download Clients", href: "/settings/download-clients" },
  { label: "Library Import", href: "/settings/library-import" },
  { label: "Organizer", href: "/settings/organizer" },
  { label: "Migrate", href: "/settings/migrate" },
  { label: "General", href: "/settings/general" },
  { label: "Failures", href: "/settings/failures" },
  { label: "Logs", href: "/settings/logs" },
  { label: "Tasks", href: "/system/tasks" },
] as const;

/** Dashboard highlights only on exactly /settings; others match their route + sub-paths. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/settings") return pathname === "/settings";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ManageLink({
  href,
  label,
  onNavigate,
}: {
  href: string;
  label: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "rounded px-3 py-2 text-sm transition-colors",
        active
          ? "bg-red-600/15 font-medium text-red-400"
          : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
      )}
    >
      {label}
    </Link>
  );
}

/**
 * The admin panel chrome: a clean, dark management sidebar (static on desktop,
 * a slide-over drawer on mobile toggled from a fixed top bar) wrapped around the
 * settings/system pages. Holds the media-box wordmark, a "back to browse" link,
 * the management nav, and sign-out. The drawer closes on navigation.
 */
export function AdminPanel({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <div className="flex min-h-screen bg-[#141414] text-white">
      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-zinc-800 bg-zinc-950/90 px-4 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open management menu"
          className="inline-flex size-9 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
          </svg>
        </button>
        <Link
          href="/discover"
          className="text-lg font-extrabold uppercase tracking-tight text-red-600"
        >
          media-box
        </Link>
      </header>

      {/* Backdrop when the mobile drawer is open */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — static column on desktop, slide-over on mobile */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:static md:z-auto md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <aside className="flex h-full w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-800 bg-zinc-900/70 p-4">
          <Link
            href="/discover"
            className="px-1 text-xl font-extrabold uppercase tracking-tight text-red-600"
          >
            media-box
          </Link>

          <Link
            href="/discover"
            className="flex items-center gap-2 rounded border border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            <span aria-hidden>&larr;</span> Back to browse
          </Link>

          <div>
            <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Management
            </div>
            <nav className="flex flex-col gap-1">
              {NAV.map((item) => (
                <ManageLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </nav>
          </div>

          <div className="mt-auto border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={logout}
              className="w-full rounded px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              Sign out
            </button>
          </div>
        </aside>
      </div>

      <main className="min-w-0 flex-1 p-6 pt-20 md:p-8">{children}</main>
    </div>
  );
}
