"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui";
import { VideoPlayerModal } from "@/components/media-player";
import { cn } from "@/lib/cn";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/**
 * Netflix-style landscape (16:9) title card. On hover the card scales up, lifts
 * above its neighbours, and reveals an info panel with the primary action.
 * Mirrors PosterCard's availability logic:
 *   available + movie  → ▶ play in a VideoPlayerModal
 *   available + series → ▶ link to the series page
 *   unavailable        → ＋ request (flips to a check locally)
 *   requested          → check (disabled)
 *
 * The outer wrapper is `w-full` so parents control the width: rows wrap it in a
 * fixed `w-[240px] shrink-0` cell, grids let it fill the grid cell.
 */
export function TitleCard({ item }: { item: DiscoverItem }) {
  const toast = useToast();
  const [status, setStatus] = useState(item.status);
  const [requesting, setRequesting] = useState(false);
  const [playing, setPlaying] = useState(false);

  const detailHref =
    item.mediaId != null
      ? item.mediaType === "movie"
        ? `/movies/${item.mediaId}`
        : `/series/${item.mediaId}`
      : null;

  const canPlayMovie = status === "available" && item.mediaType === "movie" && item.mediaId != null;
  const image = item.backdrop ?? item.poster;

  async function request() {
    setRequesting(true);
    try {
      const created = await apiFetch<{ status: string }>("/requests", {
        method: "POST",
        body: JSON.stringify({
          mediaType: item.mediaType,
          tmdbId: item.tmdbId,
          title: item.title,
          year: item.year,
          posterPath: item.posterPath,
        }),
      });
      setStatus("requested");
      toast.success(created.status === "pending" ? "Requested" : "Added to your library");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStatus("requested");
        toast.info("Already requested");
      } else {
        toast.error(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      setRequesting(false);
    }
  }

  const circleBase =
    "flex size-8 shrink-0 items-center justify-center rounded-full text-sm transition-colors";

  return (
    <div className="group relative aspect-video w-full">
      {/* Scaling layer — transform keeps the row layout from reflowing. The
          origin defaults to center but is overridden per-column in grids (via the
          inherited --card-origin) so edge cards scale inward, not off-screen. */}
      <div
        style={{ transformOrigin: "var(--card-origin, center)" }}
        className="absolute inset-0 rounded-md transition-transform duration-300 ease-out group-hover:z-30 group-hover:scale-[1.3] group-focus-within:z-30 group-focus-within:scale-[1.3]"
      >
        <div className="relative h-full w-full overflow-hidden rounded-md bg-zinc-900 shadow-lg group-hover:shadow-2xl">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-zinc-500">
              {item.title}
            </div>
          )}

          {/* Availability corner */}
          {status === "available" && (
            <span
              className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-bold text-black"
              aria-label="Available"
            >
              ✓
            </span>
          )}
          {status === "requested" && (
            <span className="absolute right-1.5 top-1.5 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-black">
              Requested
            </span>
          )}

          {/* Always-on name band so titles are identifiable without hovering.
              Fades out on hover/focus as the info panel below covers this area. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-8 transition-opacity duration-300 group-hover:opacity-0 group-focus-within:opacity-0">
            <div className="truncate text-sm font-medium text-white drop-shadow">{item.title}</div>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-300">
              {item.year != null && <span>{item.year}</span>}
              {item.year != null && <span className="text-zinc-500">·</span>}
              <span>{item.mediaType === "movie" ? "Movie" : "Series"}</span>
            </div>
          </div>

          {/* Whole-card link to the detail page (in-library titles). Sits above the
              artwork but below the action buttons (which are z-30 + pointer-events)
              so Play / Request keep working while the rest of the card opens details. */}
          {detailHref && (
            <Link
              href={detailHref}
              aria-label={`View details for ${item.title}`}
              className="absolute inset-0 z-20 rounded-md"
            />
          )}

          {/* Hover info panel (over the image, so it adds no height to clip).
              pointer-events-none lets clicks fall through to the detail link;
              the action buttons re-enable pointer events for themselves. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex translate-y-2 items-center gap-2 bg-gradient-to-t from-black via-black/85 to-transparent px-2 pb-2 pt-8 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
            {canPlayMovie && (
              <button
                type="button"
                onClick={() => setPlaying(true)}
                className={cn(circleBase, "pointer-events-auto bg-white text-black hover:bg-white/80")}
                aria-label={`Play ${item.title}`}
              >
                ▶
              </button>
            )}
            {/* In-library titles: a clear "more info" action to the detail page
                (the whole card links there too). For series this is the primary
                action — the detail page is where you pick an episode to play. */}
            {detailHref && (
              <Link
                href={detailHref}
                className={cn(
                  circleBase,
                  "pointer-events-auto border border-white/70 text-white hover:border-white hover:bg-white/10"
                )}
                aria-label={`More info about ${item.title}`}
                title="More info"
              >
                ⓘ
              </Link>
            )}
            {status === "unavailable" && (
              <button
                type="button"
                onClick={request}
                disabled={requesting}
                className={cn(
                  circleBase,
                  "pointer-events-auto border border-white/60 text-white hover:border-white disabled:opacity-50"
                )}
                aria-label={`Request ${item.title}`}
              >
                ＋
              </button>
            )}
            {status === "requested" && (
              <span
                className={cn(circleBase, "border border-white/60 text-white")}
                aria-label="Requested"
              >
                ✓
              </span>
            )}

            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-white">{item.title}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-300">
                {item.year != null && <span>{item.year}</span>}
                <span className="uppercase tracking-wide">
                  {item.mediaType === "movie" ? "Movie" : "Series"}
                </span>
              </div>
            </div>

            {status === "available" && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                Available
              </span>
            )}
          </div>
        </div>
      </div>

      {playing && item.mediaId != null && (
        <VideoPlayerModal
          target={{ type: "movie", id: item.mediaId }}
          title={item.title}
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}
