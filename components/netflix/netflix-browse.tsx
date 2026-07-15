"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { Input } from "@/components/ui";
import { HeroBillboard } from "./hero-billboard";
import { NetflixRow } from "./netflix-row";
import { TitleCard } from "./title-card";
import { useGridCardOrigin } from "./use-grid-card-origin";
import { useOptionalSearch } from "./search-context";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

export type BrowseRow = { title: string; category: string };

/** How many titles the hero billboard rotates through. */
const HERO_COUNT = 8;

/**
 * A full Netflix browse view driven by a config: a hero billboard picked from
 * `heroCategory`, followed by a stack of horizontally-scrolling rows. Each row
 * fetches its own category (per-row error/empty is skipped, undefined shows a
 * skeleton). When the shared search query is non-empty it swaps to a results
 * grid instead. Admins (no SearchProvider) get a page-level search box.
 */
export function NetflixBrowse({
  heroCategory,
  rows,
  leadingRows,
}: {
  heroCategory: string;
  rows: BrowseRow[];
  /** Extra rows rendered above the mapped feed rows (ignored in search mode). */
  leadingRows?: React.ReactNode;
}) {
  // Normal users share the header's search box via context; admins render in the
  // sidebar shell with no header, so they fall back to a page-level box.
  const shared = useOptionalSearch();
  const [localQuery, setLocalQuery] = useState("");
  const query = shared ? shared.query : localQuery;
  const setQuery = shared ? shared.setQuery : setLocalQuery;
  const showOwnSearchBox = !shared;
  const availableOnly = shared?.availableOnly ?? false;

  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  // Keep library availability fresh as the server imports/removes files.
  useEvents();

  const searching = debounced.length > 0;

  // SWR keys are null when inactive, which disables the fetch.
  const search = useApi<DiscoverItem[]>(
    searching ? `/discover?category=search&q=${encodeURIComponent(debounced)}` : null
  );
  const heroFeed = useApi<DiscoverItem[]>(searching ? null : `/discover?category=${heroCategory}`);
  // Rotating hero candidates: the hero feed (respecting availableOnly) narrowed to
  // titles with a backdrop, capped at HERO_COUNT. Memoized so the list keeps a
  // stable identity across renders and the billboard's rotation timer isn't reset.
  const heroItems = useMemo(() => {
    const data = heroFeed.data;
    const filtered = data && availableOnly ? data.filter((i) => i.status === "available") : data;
    if (!filtered) return [];
    return filtered.filter((i) => i.backdrop).slice(0, HERO_COUNT);
  }, [heroFeed.data, availableOnly]);

  if (searching) {
    return (
      <div className="min-h-screen px-4 pb-16 pt-24 md:px-12">
        {showOwnSearchBox && (
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Movies & TV"
            aria-label="Search Movies & TV"
            className="mb-6 max-w-xl"
          />
        )}
        <SearchResults
          query={debounced}
          items={search.data}
          error={search.error}
          availableOnly={availableOnly}
        />
      </div>
    );
  }

  return (
    <div className="pb-16">
      {showOwnSearchBox && (
        <div className="px-4 pt-2 md:px-12">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Movies & TV"
            aria-label="Search Movies & TV"
            className="max-w-xl"
          />
        </div>
      )}

      {heroItems.length > 0 ? (
        <HeroBillboard items={heroItems} />
      ) : (
        <div className="h-[40vh] w-full bg-gradient-to-b from-zinc-900 to-[#141414]" />
      )}

      <div className="relative z-10 -mt-24 space-y-4 md:space-y-8">
        {leadingRows}
        {rows.map((r) => (
          <BrowseRow
            key={`${r.category}-${r.title}`}
            title={r.title}
            category={r.category}
            availableOnly={availableOnly}
          />
        ))}
      </div>
    </div>
  );
}

/** One row: fetches its own feed so hooks stay stable regardless of row count. */
function BrowseRow({ title, category, availableOnly }: BrowseRow & { availableOnly: boolean }) {
  const { data, error } = useApi<DiscoverItem[]>(`/discover?category=${category}`);
  // A per-row error (e.g. no TMDB key) becomes an empty row, which NetflixRow skips.
  const items = error ? [] : availableOnly && data ? data.filter((i) => i.status === "available") : data;
  return <NetflixRow title={title} items={items} />;
}

type SearchType = "all" | "movie" | "series" | "anime";
const TYPE_LABELS: Record<SearchType, string> = {
  all: "All",
  movie: "Movies",
  series: "Series",
  anime: "Anime",
};

function SearchResults({
  query,
  items,
  error,
  availableOnly,
}: {
  query: string;
  items: DiscoverItem[] | undefined;
  error: unknown;
  availableOnly: boolean;
}) {
  const [type, setType] = useState<SearchType>("all");
  const gridRef = useRef<HTMLDivElement>(null);
  // Keep edge cards scaling inward as the result set / filter / breakpoint change.
  useGridCardOrigin(gridRef, [items, type, availableOnly]);

  if (error) {
    return (
      <p className="text-sm text-zinc-400">
        Search is unavailable — a TMDB API key may be needed in Settings.
      </p>
    );
  }

  const pills = (
    <div className="mb-6 flex flex-wrap gap-2">
      {(Object.keys(TYPE_LABELS) as SearchType[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => setType(t)}
          className={cn(
            "rounded-full border px-4 py-1 text-sm font-medium transition-colors",
            type === t
              ? "border-white bg-white text-black"
              : "border-white/25 text-zinc-300 hover:bg-white/10"
          )}
        >
          {TYPE_LABELS[t]}
        </button>
      ))}
    </div>
  );

  if (items === undefined) {
    return (
      <>
        {pills}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-video w-full animate-pulse rounded-md bg-zinc-800" />
          ))}
        </div>
      </>
    );
  }

  let filtered = items;
  if (availableOnly) filtered = filtered.filter((i) => i.status === "available");
  if (type === "movie") filtered = filtered.filter((i) => i.mediaType === "movie" && !i.isAnime);
  else if (type === "series") filtered = filtered.filter((i) => i.mediaType === "series" && !i.isAnime);
  else if (type === "anime") filtered = filtered.filter((i) => i.isAnime);

  return (
    <>
      <h2 className="mb-4 text-lg font-semibold text-zinc-200">Results for “{query}”</h2>
      {pills}
      {filtered.length === 0 ? (
        <div className="py-10 text-zinc-400">
          <p className="text-lg font-semibold text-zinc-200">No matching results</p>
          <p className="mt-1 text-sm">
            {availableOnly ? "Turn off “Available only” or try a" : "Try a"} different filter or title.
          </p>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="grid grid-cols-1 gap-x-4 gap-y-10 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
        >
          {filtered.map((item) => (
            <TitleCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
          ))}
        </div>
      )}
    </>
  );
}
