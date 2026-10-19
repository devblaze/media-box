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

type NavItem = {
  label: string;
  href: string;
  icon: IconName;
  match?: (pathname: string) => boolean;
};

/** Browse first, then what you already have, then the rest. */
const NAV: NavItem[] = [
  { label: "Home", href: "/discover", icon: "home", match: (p) => p === "/discover" },
  { label: "Movies", href: "/discover/movies", icon: "film" },
  { label: "Series", href: "/discover/series", icon: "tv" },
  { label: "Anime", href: "/discover/anime", icon: "sparkle" },
  // Everything in the library, ready to play: the movie and series grids.
  {
    label: "Library",
    href: "/movies",
    icon: "library",
    match: (p) => p === "/movies" || p === "/series",
  },
  { label: "Channels", href: "/channels", icon: "broadcast" },
  { label: "My List", href: "/requests", icon: "list" },
  { label: "Calendar", href: "/calendar", icon: "calendar" },
];

/** The phone tab bar: the four places people go most, plus search. */
const TAB_BAR = ["/discover", "/discover/movies", "/discover/series", "/movies"];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.match) return item.match(pathname);
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

type IconName =
  | "home"
  | "film"
  | "tv"
  | "sparkle"
  | "library"
  | "broadcast"
  | "list"
  | "calendar"
  | "search";

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" />
    </>
  ),
  tv: (
    <>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="m8 2 4 4 4-4" />
    </>
  ),
  sparkle: <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />,
  library: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
};

function NavIcon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * The fixed top bar of the browse shell. Transparent (with a top-down gradient)
 * over the hero; frosted near-black once scrolled past ~20px. Holds the wordmark,
 * the nav, an expanding search box (writes the shared SearchContext, navigating
 * to /discover when needed; `/` or Ctrl/⌘K opens it from anywhere) and an avatar
 * menu. On phones the main destinations move to a tab bar along the bottom.
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

  // `/` or Ctrl/⌘K jumps to search, as on most sites with one.
  useEffect(() => {
    if (!search) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
      const palette = e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey);
      if (!slash && !palette) return;
      e.preventDefault();
      setSearchOpen(true);
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search]);

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
    <>
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
          scrolled
            ? "border-b border-white/5 bg-[#141414]/90 shadow-lg shadow-black/30 backdrop-blur-xl"
            : "bg-gradient-to-b from-black/80 via-black/40 to-transparent"
        )}
      >
        <div className="flex h-16 items-center gap-4 px-4 md:px-12">
          {/* Mobile nav toggle */}
          <button
            type="button"
            onClick={() => setNavOpen((o) => !o)}
            aria-label="Toggle navigation"
            className="inline-flex size-9 items-center justify-center rounded-full text-zinc-200 hover:bg-white/10 lg:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>

          <Link
            href="/discover"
            onClick={() => setNavOpen(false)}
            className="shrink-0 text-xl font-extrabold tracking-tight whitespace-nowrap text-red-600 uppercase sm:text-2xl"
          >
            media-box
          </Link>

          <nav className="hidden items-center gap-1 text-sm lg:flex">
            {NAV.map((n) => {
              const active = isActive(pathname, n);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-full px-3 py-1.5 font-medium transition-colors",
                    active
                      ? "bg-white/15 text-white"
                      : "text-zinc-300 hover:bg-white/10 hover:text-white"
                  )}
                >
                  {n.label}
                </Link>
              );
            })}
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
                  "flex items-center rounded-full transition-all duration-300 ease-out",
                  searchOpen
                    ? "border border-white/30 bg-black/70 pr-3 shadow-lg backdrop-blur"
                    : "border border-transparent"
                )}
              >
                <button
                  type="button"
                  onClick={() => setSearchOpen((o) => (o && !search.query ? false : true))}
                  aria-label="Search"
                  aria-expanded={searchOpen}
                  title="Search ( / )"
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10"
                >
                  <NavIcon
                    name="search"
                    className={cn("transition-colors", searchOpen && "text-zinc-400")}
                  />
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
                    searchOpen
                      ? "w-40 pl-1 opacity-100 sm:w-56"
                      : "pointer-events-none w-0 opacity-0"
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
                    <div className="truncate px-3 py-1.5 text-zinc-400">
                      {me?.username ?? "Account"}
                    </div>
                    <div className="my-1 border-t border-white/10" />
                    <Link
                      href="/account"
                      onClick={() => setMenuOpen(false)}
                      className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10"
                    >
                      Account
                    </Link>
                    <Link
                      href="/apps"
                      onClick={() => setMenuOpen(false)}
                      className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10"
                    >
                      Get the app
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

        {/* Compact-screen nav: every destination, with its icon. */}
        {navOpen && (
          <nav className="grid grid-cols-2 gap-1 border-t border-white/10 bg-[#141414]/95 px-4 py-3 text-sm backdrop-blur-xl sm:grid-cols-4 lg:hidden">
            {NAV.map((n) => {
              const active = isActive(pathname, n);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setNavOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors",
                    active
                      ? "bg-white/15 font-semibold text-white"
                      : "text-zinc-300 hover:bg-white/10"
                  )}
                >
                  <NavIcon name={n.icon} className="size-4.5" />
                  {n.label}
                </Link>
              );
            })}
          </nav>
        )}
      </header>

      {/* Phone tab bar: the main destinations a thumb's reach away. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-[#141414]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
      >
        <div className="grid grid-cols-5">
          {NAV.filter((n) => TAB_BAR.includes(n.href)).map((n) => {
            const active = isActive(pathname, n);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-1 py-2 text-[11px] font-medium transition-colors",
                  active ? "text-white" : "text-zinc-500 hover:text-zinc-200"
                )}
              >
                <NavIcon name={n.icon} className={cn("size-6", active && "text-red-500")} />
                {n.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => {
              window.scrollTo({ top: 0, behavior: "smooth" });
              setSearchOpen(true);
              searchInputRef.current?.focus();
            }}
            className="flex flex-col items-center gap-1 py-2 text-[11px] font-medium text-zinc-500 transition-colors hover:text-zinc-200"
          >
            <NavIcon name="search" className="size-6" />
            Search
          </button>
        </div>
      </nav>
    </>
  );
}
