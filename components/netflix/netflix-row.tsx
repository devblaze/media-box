"use client";

import { TitleCard } from "./title-card";
import { ROW_CARD_CLASS, ScrollRow } from "./scroll-row";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/**
 * A titled row of TitleCards. items === undefined → skeletons while it loads;
 * empty → the row is skipped entirely.
 */
export function NetflixRow({ title, items }: { title: string; items: DiscoverItem[] | undefined }) {
  if (items && items.length === 0) return null;

  return (
    <ScrollRow title={title}>
      {items === undefined
        ? Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={`${ROW_CARD_CLASS} aspect-video animate-pulse rounded-xl bg-zinc-800/80`}
            />
          ))
        : items.map((item) => (
            <div key={`${item.mediaType}-${item.tmdbId}`} className={ROW_CARD_CLASS}>
              <TitleCard item={item} />
            </div>
          ))}
    </ScrollRow>
  );
}
