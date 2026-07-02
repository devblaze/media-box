"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/api";
import { Sidebar } from "@/components/sidebar";
import { NetflixHeader } from "@/components/netflix/netflix-header";
import { SearchProvider } from "@/components/netflix/search-context";

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

/**
 * Role-aware application frame.
 *   admin → the management sidebar shell (unchanged).
 *   user  → a Netflix-style shell: a fixed <NetflixHeader/> over a full-bleed,
 *           near-black <main>. Discover is edge-to-edge and sits under the
 *           transparent header; other pages get top room to clear it.
 * While /auth/me is loading we render a black screen so the sidebar never
 * flashes for normal users.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { data: me } = useApi<Me>("/auth/me");
  const pathname = usePathname();

  if (!me) return <div className="min-h-screen bg-black" />;

  if (me.role === "admin") return <SidebarShell>{children}</SidebarShell>;

  return (
    <SearchProvider>
      <NetflixHeader />
      <main
        className={cn(
          "min-h-screen bg-[#141414] text-white",
          pathname === "/discover" || pathname.startsWith("/discover/") ? "" : "pt-16"
        )}
      >
        {children}
      </main>
    </SearchProvider>
  );
}

/**
 * The original responsive management frame: a static sidebar on desktop (md+)
 * and a slide-over drawer on mobile, toggled from a fixed top bar. The drawer
 * closes automatically on navigation.
 */
function SidebarShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-screen">
      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-zinc-800 bg-zinc-950/90 px-4 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation menu"
          className="inline-flex size-9 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
          </svg>
        </button>
        <Link href="/" className="font-semibold tracking-tight text-amber-400">
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
        <Sidebar />
      </div>

      <main className="min-w-0 flex-1 p-4 pt-16 md:p-6 md:pt-6">{children}</main>
    </div>
  );
}
