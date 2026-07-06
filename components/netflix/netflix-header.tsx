"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/api";
import { WatchTogetherButton } from "@/components/watch-together";
import { useOptionalSearch } from "./search-context";

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

const NAV = [
  { label: "Home", href: "/discover" },
  { label: "Channels", href: "/channels" },
  { label: "Movies", href: "/discover/movies" },
  { label: "Series", href: "/discover/series" },
  { label: "Anime", href: "/discover/anime" },
  { label: "My List", href: "/requests" },
  { label: "Calendar", href: "/calendar" },
] as const;

/** Home highlights only on exactly /discover; others match their route + sub-paths. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/discover") return pathname === "/discover";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * Fixed Netflix top bar for non-admin users. Transparent (with a top-down
 * gradient) at the top of the page; fades to solid #141414 once scrolled past
 * ~20px. Holds the red wordmark, nav links, an expanding search box (writes the
 * shared SearchContext, navigating to /discover when needed) and an avatar
 * dropdown with the username + Sign out.
 */
export function NetflixHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me } = useApi<Me>("/auth/me");
  const search = useOptionalSearch();

  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus the field once it has finished expanding (autoFocus won't re-fire on a
  // persistent input, and focusing mid-animation fights the width transition).
  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => searchInputRef.current?.focus(), 180);
    return () => clearTimeout(t);
  }, [searchOpen]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  function onSearch(value: string) {
    search?.setQuery(value);
    if (value && pathname !== "/discover") router.push("/discover");
  }

  const initial = me?.username?.charAt(0).toUpperCase() ?? "U";

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
        scrolled ? "bg-[#141414]" : "bg-gradient-to-b from-black/80 via-black/40 to-transparent"
      )}
    >
      <div className="flex h-16 items-center gap-4 px-4 md:px-12">
        {/* Mobile nav toggle */}
        <button
          type="button"
          onClick={() => setNavOpen((o) => !o)}
          aria-label="Toggle navigation"
          className="inline-flex size-9 items-center justify-center rounded text-zinc-200 hover:bg-white/10 md:hidden"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
          </svg>
        </button>

        <Link
          href="/discover"
          onClick={() => setNavOpen(false)}
          className="text-2xl font-extrabold uppercase tracking-tight text-red-600"
        >
          media-box
        </Link>

        <nav className="hidden items-center gap-5 text-sm md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "transition-colors hover:text-white",
                isActive(pathname, n.href) ? "font-semibold text-white" : "text-zinc-300"
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 md:gap-3">
          {search && (
            <button
              type="button"
              onClick={() => search.setAvailableOnly(!search.availableOnly)}
              aria-pressed={search.availableOnly}
              title="Show only titles already in your library"
              className={cn(
                "hidden items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors sm:inline-flex",
                search.availableOnly
                  ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                  : "border-white/25 text-zinc-300 hover:bg-white/10"
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  search.availableOnly ? "bg-emerald-400" : "bg-zinc-500"
                )}
              />
              Available only
            </button>
          )}
          {search && (
            // Persistent container so the field can smoothly expand/collapse: the
            // icon stays anchored while the input's width + the border/background
            // animate in and out (Netflix-style), instead of swapping abruptly.
            <div
              className={cn(
                "flex items-center rounded-md transition-all duration-300 ease-out",
                searchOpen
                  ? "border border-white/40 bg-black/70 pr-2 shadow-lg"
                  : "border border-transparent"
              )}
            >
              <button
                type="button"
                onClick={() =>
                  setSearchOpen((o) => (o && !search.query ? false : true))
                }
                aria-label="Search"
                aria-expanded={searchOpen}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-white transition-colors hover:bg-white/10"
              >
                <SearchIcon className={cn("transition-colors", searchOpen && "text-zinc-400")} />
              </button>
              <input
                ref={searchInputRef}
                type="search"
                value={search.query}
                onChange={(e) => onSearch(e.target.value)}
                onBlur={() => {
                  if (!search.query) setSearchOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    onSearch("");
                    setSearchOpen(false);
                    searchInputRef.current?.blur();
                  }
                }}
                placeholder="Titles, people, genres"
                aria-label="Search titles"
                aria-hidden={!searchOpen}
                tabIndex={searchOpen ? 0 : -1}
                className={cn(
                  "h-9 bg-transparent text-sm text-white outline-none transition-all duration-300 ease-out placeholder:text-zinc-500",
                  searchOpen ? "w-40 pl-1 opacity-100 sm:w-56" : "pointer-events-none w-0 opacity-0"
                )}
              />
            </div>
          )}

          <WatchTogetherButton />

          {me?.role === "admin" && (
            <Link
              href="/settings"
              title="Manage"
              className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-white/10"
            >
              <GearIcon />
              <span className="hidden sm:inline">Manage</span>
            </Link>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Account menu"
              aria-expanded={menuOpen}
              className="flex size-8 items-center justify-center rounded bg-red-600 text-sm font-semibold text-white"
            >
              {initial}
            </button>
            {menuOpen && (
              <>
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  onClick={() => setMenuOpen(false)}
                  className="fixed inset-0 z-40 cursor-default"
                />
                <div className="absolute right-0 z-50 mt-2 w-48 rounded border border-white/10 bg-black/95 py-2 text-sm shadow-xl backdrop-blur">
                  <div className="truncate px-3 py-1.5 text-zinc-400">{me?.username ?? "Account"}</div>
                  <div className="my-1 border-t border-white/10" />
                  <Link
                    href="/account"
                    onClick={() => setMenuOpen(false)}
                    className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10"
                  >
                    Account
                  </Link>
                  <button
                    type="button"
                    onClick={logout}
                    className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10"
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Mobile nav dropdown */}
      {navOpen && (
        <nav className="flex flex-col gap-1 border-t border-white/10 bg-[#141414] px-4 py-3 text-sm md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setNavOpen(false)}
              className={cn(
                "rounded px-2 py-2 transition-colors hover:bg-white/10",
                isActive(pathname, n.href) ? "font-semibold text-white" : "text-zinc-300"
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
