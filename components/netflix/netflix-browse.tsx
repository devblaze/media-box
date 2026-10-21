"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { Input, Spinner } from "@/components/ui";
import { HeroBillboard } from "./hero-billboard";
import { NetflixRow } from "./netflix-row";
import { TitleCard } from "./title-card";
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
  // Keep the last results up while the next query loads, rather than blanking
  // the grid on every keystroke; a failed search waits for Retry, not a loop.
  const search = useApi<DiscoverItem[]>(
    searching ? `/discover?category=search&q=${encodeURIComponent(debounced)}` : null,
    { keepPreviousData: true, revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const heroFeed = useApi<DiscoverItem[]>(searching ? null : `/discover?category=${heroCategory}`);
  // The hero feed comes from TMDB. Without it (no API key, no internet) or with
  // nothing to show, feature what's newest in the library instead, so a server
  // that only plays its own files still opens on a billboard.
  const heroMissing =
    !searching &&
    (heroFeed.error != null ||
      (heroFeed.data && heroCandidates(heroFeed.data, availableOnly).length === 0));
  const libraryFeed = useApi<DiscoverItem[]>(
    heroMissing ? "/discover?category=recently-added" : null
  );
  // Memoized so the list keeps a stable identity across renders and the
  // billboard's rotation timer isn't reset.
  const heroItems = useMemo(() => {
    const primary = heroCandidates(heroFeed.data, availableOnly);
    return primary.length > 0 ? primary : heroCandidates(libraryFeed.data, availableOnly);
  }, [heroFeed.data, libraryFeed.data, availableOnly]);

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
          loading={search.isLoading}
          error={search.error}
          onRetry={() => void search.mutate()}
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

      <div className="relative z-10 -mt-24 space-y-6 md:space-y-10">
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

/** The titles a feed offers the hero: ones with a backdrop to show, capped. */
function heroCandidates(data: DiscoverItem[] | undefined, availableOnly: boolean): DiscoverItem[] {
  if (!data) return [];
  return data
    .filter((i) => i.backdrop && (!availableOnly || i.status === "available"))
    .slice(0, HERO_COUNT);
}

/** One row: fetches its own feed so hooks stay stable regardless of row count. */
function BrowseRow({ title, category, availableOnly }: BrowseRow & { availableOnly: boolean }) {
  const { data, error } = useApi<DiscoverItem[]>(`/discover?category=${category}`);
  // A per-row error (e.g. no TMDB key) becomes an empty row, which NetflixRow skips.
  const items = error
    ? []
    : availableOnly && data
      ? data.filter((i) => i.status === "available")
      : data;
  return <NetflixRow title={title} items={items} />;
}

/** Search results: the same landscape cards as the rows, a little bigger than a row's. */
const RESULTS_GRID =
  "grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4";

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
  loading,
  error,
  onRetry,
  availableOnly,
}: {
  query: string;
  /** The latest results — the previous query's while this one loads. */
  items: DiscoverItem[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  availableOnly: boolean;
}) {
  const [type, setType] = useState<SearchType>("all");

  if (error && !loading) {
    return (
      <div className="flex flex-col items-start gap-3 py-10">
        <p className="text-lg font-semibold text-zinc-200">Search didn’t work</p>
        <p className="max-w-xl text-sm text-zinc-400">{searchErrorText(error)}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/85"
        >
          Try again
        </button>
      </div>
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
        <SlowNotice />
        <div className={RESULTS_GRID}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-video w-full animate-pulse rounded-xl bg-zinc-800/80" />
          ))}
        </div>
      </>
    );
  }

  let filtered = items;
  if (availableOnly) filtered = filtered.filter((i) => i.status === "available");
  if (type === "movie") filtered = filtered.filter((i) => i.mediaType === "movie" && !i.isAnime);
  else if (type === "series")
    filtered = filtered.filter((i) => i.mediaType === "series" && !i.isAnime);
  else if (type === "anime") filtered = filtered.filter((i) => i.isAnime);

  return (
    <>
      <h2 className="mb-4 flex items-center gap-3 text-2xl font-bold tracking-tight text-white">
        Results for “{query}”{loading && <Spinner className="size-5 text-zinc-400" />}
      </h2>
      {pills}
      {filtered.length === 0 ? (
        <div className="py-10 text-zinc-400">
          <p className="text-lg font-semibold text-zinc-200">No matching results</p>
          <p className="mt-1 text-sm">
            {availableOnly ? "Turn off “Available only” or try a" : "Try a"} different filter or
            title.
          </p>
        </div>
      ) : (
        <div className={RESULTS_GRID}>
          {filtered.map((item) => (
            <TitleCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
          ))}
        </div>
      )}
    </>
  );
}

/** What went wrong, with how to fix it when the server's message doesn't already say. */
function searchErrorText(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message.replace(/\.?$/, ".") : "";
  if (/TMDB API key/i.test(message)) return message;
  return `${message || "The search service didn’t answer."} Searching online needs a TMDB API key (Manage → General) and a connection to TMDB — your own library is searched either way.`;
}

/** After a few seconds of placeholders, say what's going on instead of looking frozen. */
function SlowNotice() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5_000);
    return () => clearTimeout(t);
  }, []);
  if (!slow) return null;
  return (
    <p className="mb-4 flex items-center gap-2 text-sm text-zinc-400">
      <Spinner className="size-4" />
      Still searching — TMDB is taking a while to answer.
    </p>
  );
}
