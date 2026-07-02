"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { Callout, EmptyState, Input, Skeleton } from "@/components/ui";
import { MediaCarousel } from "@/components/media-carousel";
import { PosterCard } from "@/components/poster-card";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

const GRID = "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

export default function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // Debounce the search box so we don't hit TMDB on every keystroke.
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
  const recent = useApi<DiscoverItem[]>(searching ? null : "/discover?category=recently-added");
  const trending = useApi<DiscoverItem[]>(searching ? null : "/discover?category=trending");
  const popularMovies = useApi<DiscoverItem[]>(
    searching ? null : "/discover?category=popular-movies"
  );
  const popularSeries = useApi<DiscoverItem[]>(
    searching ? null : "/discover?category=popular-series"
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Discover</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Browse and request movies &amp; TV. Play anything already in your library.
        </p>
      </div>

      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search Movies & TV"
        aria-label="Search Movies & TV"
        className="max-w-xl"
      />

      {searching ? (
        <SearchResults items={search.data} error={search.error} />
      ) : (
        <div className="space-y-8">
          <MediaCarousel title="Recently Added" items={recent.data} error={recent.error} />
          <MediaCarousel title="Trending" items={trending.data} error={trending.error} />
          <MediaCarousel
            title="Popular Movies"
            items={popularMovies.data}
            error={popularMovies.error}
            viewAllHref="/movies"
          />
          <MediaCarousel
            title="Popular Series"
            items={popularSeries.data}
            error={popularSeries.error}
            viewAllHref="/series"
          />
        </div>
      )}
    </div>
  );
}

function SearchResults({ items, error }: { items: DiscoverItem[] | undefined; error: unknown }) {
  if (error) {
    return (
      <Callout tone="info">Search failed — a TMDB API key may be needed in Settings.</Callout>
    );
  }
  if (items === undefined) {
    return (
      <div className={GRID}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="aspect-[2/3] w-full rounded-lg" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </div>
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return <EmptyState title="No results" description="Try a different search term." />;
  }
  return (
    <div className={GRID}>
      {items.map((item) => (
        <PosterCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
      ))}
    </div>
  );
}
