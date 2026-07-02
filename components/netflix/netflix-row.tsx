"use client";

import { useRef } from "react";
import { TitleCard } from "./title-card";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/**
 * A titled, horizontally-scrollable row of TitleCards. Chevron buttons fade in
 * on hover and page the track by ~one viewport. The scrollbar is hidden and the
 * track carries vertical padding so the cards' hover-scale isn't clipped.
 * items === undefined → skeletons; empty → the row is skipped entirely.
 */
export function NetflixRow({ title, items }: { title: string; items: DiscoverItem[] | undefined }) {
  const trackRef = useRef<HTMLDivElement>(null);

  function page(dir: -1 | 1) {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: "smooth" });
  }

  // Loaded and empty → skip the whole row.
  if (items && items.length === 0) return null;

  return (
    <section className="group/row relative">
      <h2 className="px-4 text-lg font-semibold text-zinc-200 md:px-12">{title}</h2>

      <div className="relative">
        <button
          type="button"
          onClick={() => page(-1)}
          aria-label="Scroll left"
          className="absolute left-0 top-0 z-20 hidden h-full w-10 items-center justify-center bg-gradient-to-r from-black/70 to-transparent text-2xl text-white opacity-0 transition-opacity hover:from-black/90 group-hover/row:opacity-100 md:flex"
        >
          ‹
        </button>

        <div
          ref={trackRef}
          className="no-scrollbar flex gap-2 overflow-x-auto scroll-smooth px-4 py-8 md:px-12"
        >
          {items === undefined
            ? Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-video w-[240px] shrink-0 animate-pulse rounded-md bg-zinc-800"
                />
              ))
            : items.map((item) => (
                <div key={`${item.mediaType}-${item.tmdbId}`} className="w-[240px] shrink-0">
                  <TitleCard item={item} />
                </div>
              ))}
        </div>

        <button
          type="button"
          onClick={() => page(1)}
          aria-label="Scroll right"
          className="absolute right-0 top-0 z-20 hidden h-full w-10 items-center justify-center bg-gradient-to-l from-black/70 to-transparent text-2xl text-white opacity-0 transition-opacity hover:from-black/90 group-hover/row:opacity-100 md:flex"
        >
          ›
        </button>
      </div>
    </section>
  );
}
