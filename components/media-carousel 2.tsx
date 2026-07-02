"use client";

import Link from "next/link";
import { Callout, Skeleton } from "@/components/ui";
import { PosterCard } from "@/components/poster-card";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/** A horizontal, snap-scrolling row of PosterCards for one Discover category. */
export function MediaCarousel({
  title,
  items,
  error,
  viewAllHref,
}: {
  title: string;
  items: DiscoverItem[] | undefined;
  error?: unknown;
  viewAllHref?: string;
}) {
  // Loaded and empty → skip the whole section.
  if (!error && items && items.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        {viewAllHref && (
          <Link href={viewAllHref} className="shrink-0 text-xs text-amber-400 hover:underline">
            View all
          </Link>
        )}
      </div>

      {error ? (
        <Callout tone="info">
          Couldn&apos;t load — a TMDB API key may be needed in Settings.
        </Callout>
      ) : items === undefined ? (
        <div className="flex gap-3 overflow-x-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="w-36 shrink-0 sm:w-40">
              <Skeleton className="aspect-[2/3] w-full rounded-lg" />
              <Skeleton className="mt-2 h-4 w-3/4" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex snap-x gap-3 overflow-x-auto pb-2">
          {items.map((item) => (
            <div
              key={`${item.mediaType}-${item.tmdbId}`}
              className="w-36 shrink-0 snap-start sm:w-40"
            >
              <PosterCard item={item} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
