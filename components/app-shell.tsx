"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/api";
import { AdminPanel } from "@/components/admin-panel";
import { NetflixHeader } from "@/components/netflix/netflix-header";
import { SearchProvider } from "@/components/netflix/search-context";
import { BackgroundTaskNotifier } from "@/components/background-task-notifier";

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

/**
 * Route-aware application frame. Everyone — admin and user alike — browses in
 * the Netflix shell; management routes get the admin-panel chrome.
 *   /settings/* or /system/*        → <AdminPanel/> (a clean management sidebar).
 *   movie/series detail (admins)    → also <AdminPanel/>, so drilling into a
 *                                     title from Monitoring to manage its
 *                                     episodes keeps the management sidebar.
 *   everything else                 → a Netflix-style shell: a fixed
 *                                     <NetflixHeader/> over a full-bleed,
 *                                     near-black <main>. Discover is edge-to-edge
 *                                     under the transparent header; other pages
 *                                     get top room to clear it.
 * While /auth/me is loading we render a black screen so nothing flashes.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { data: me } = useApi<Me>("/auth/me");
  const pathname = usePathname();

  if (!me) return <div className="min-h-screen bg-black" />;

  // Cross-page notifier for admins (e.g. background "Import all" completion).
  const notifier = me.role === "admin" ? <BackgroundTaskNotifier /> : null;

  // A movie/series *detail* page (has an id segment) — these are management
  // surfaces for admins (monitoring, refresh/rescan/remove, per-episode search).
  const isDetailPage =
    pathname.startsWith("/movies/") || pathname.startsWith("/series/");

  // Management chrome for the admin panel routes (server-side admin-guarded), and
  // for admins on detail pages so the sidebar stays put while managing a title.
  if (
    pathname.startsWith("/settings") ||
    pathname.startsWith("/system") ||
    (me.role === "admin" && isDetailPage)
  ) {
    return (
      <>
        {notifier}
        <AdminPanel>{children}</AdminPanel>
      </>
    );
  }

  // Netflix browse shell for every user.
  return (
    <SearchProvider>
      {notifier}
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
