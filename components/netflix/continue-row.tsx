"use client";

import { useRef, useState } from "react";
import { VideoPlayerModal } from "@/components/media-player";
// Type-only import: the service is a server module, erased from the client bundle.
import type { ContinueItem } from "@/server/playback/watch-progress-service";

/**
 * A titled, horizontally-scrollable row of resume cards (Continue Watching /
 * Recently Watched). Mirrors {@link NetflixRow}'s chrome — hidden scrollbar,
 * hover chevrons, vertical padding so the cards' hover-scale isn't clipped —
 * but each landscape card shows the item's backdrop, title, an optional episode
 * subtitle, and a progress bar, and clicking it opens the player.
 *
 * `items` undefined (still loading) or empty → the row renders nothing.
 */
export function ContinueRow({ title, items }: { title: string; items: ContinueItem[] | undefined }) {
  const trackRef = useRef<HTMLDivElement>(null);

  function page(dir: -1 | 1) {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: "smooth" });
  }

  // Nothing to resume → skip the whole row.
  if (!items || items.length === 0) return null;

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
          {items.map((item) => (
            <div
              key={`${item.kind}-${item.movieId ?? ""}-${item.episodeId ?? ""}-${item.updatedAt}`}
              className="w-[240px] shrink-0"
            >
              <ContinueCard item={item} />
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

/**
 * A single landscape resume card. On hover it scales up (matching TitleCard),
 * dims with a centred play glyph, and — when the item has playback progress —
 * shows a red progress bar pinned to the bottom edge. Clicking opens the player
 * for the underlying movie or episode; the modal state is kept local to the card.
 */
function ContinueCard({ item }: { item: ContinueItem }) {
  const [playing, setPlaying] = useState(false);

  const image = item.backdrop ?? item.poster;
  // The player targets the movie for movies, or the episode for episodes.
  const targetId = item.movieId ?? item.episodeId;
  const showBar = item.progressPct > 0;

  return (
    <div className="group relative aspect-video w-full">
      {/* Scaling layer — transform keeps the row layout from reflowing. */}
      <div className="absolute inset-0 origin-center rounded-md transition-transform duration-300 ease-out group-hover:z-30 group-hover:scale-[1.3] group-focus-within:z-30 group-focus-within:scale-[1.3]">
        <button
          type="button"
          onClick={() => setPlaying(true)}
          disabled={targetId == null}
          aria-label={`Play ${item.title}`}
          className="relative block h-full w-full overflow-hidden rounded-md bg-zinc-900 text-left shadow-lg transition-shadow group-hover:shadow-2xl disabled:cursor-default"
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-zinc-500">
              {item.title}
            </div>
          )}

          {/* Hover play affordance */}
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-300 group-hover:bg-black/30 group-hover:opacity-100 group-focus-within:bg-black/30 group-focus-within:opacity-100">
            <span className="flex size-10 items-center justify-center rounded-full bg-white/90 text-lg text-black shadow-lg">
              ▶
            </span>
          </div>

          {/* Name + optional episode subtitle band */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-3 pt-8">
            <div className="truncate text-sm font-medium text-white drop-shadow">{item.title}</div>
            {item.subtitle && (
              <div className="truncate text-[10px] uppercase tracking-wide text-zinc-300">
                {item.subtitle}
              </div>
            )}
          </div>

          {/* Progress bar (skipped for queued "next episode" at 0%) */}
          {showBar && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
              <div
                className="h-full bg-red-600"
                style={{ width: `${Math.min(100, Math.max(0, item.progressPct))}%` }}
              />
            </div>
          )}
        </button>
      </div>

      {playing && targetId != null && (
        <VideoPlayerModal
          target={{ type: item.kind === "movie" ? "movie" : "episode", id: targetId }}
          title={
            <span>
              {item.title}
              {item.subtitle ? <span className="text-zinc-400"> — {item.subtitle}</span> : null}
            </span>
          }
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}
