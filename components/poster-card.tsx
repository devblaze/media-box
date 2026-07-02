"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { Badge, Button, useToast } from "@/components/ui";
import { VideoPlayerModal } from "@/components/media-player";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/**
 * Jellyseerr-style poster tile for a single Discover title. Decides its own
 * action on hover based on availability:
 *   available + movie  → ▶ Play (in-page) + Details link
 *   available + series → Watch link + Details (episodes play from the series page)
 *   requested          → disabled "Requested" (+ Details when in library)
 *   unavailable        → Request button (POSTs, flips to Requested locally)
 */
export function PosterCard({ item }: { item: DiscoverItem }) {
  const toast = useToast();
  // Local status so a fresh request flips the tile without a refetch.
  const [status, setStatus] = useState(item.status);
  const [requesting, setRequesting] = useState(false);
  const [playing, setPlaying] = useState(false);

  const detailHref =
    item.mediaId != null
      ? item.mediaType === "movie"
        ? `/movies/${item.mediaId}`
        : `/series/${item.mediaId}`
      : null;

  const canPlay = status === "available" && item.mediaType === "movie" && item.mediaId != null;
  const canWatch = status === "available" && item.mediaType === "series" && detailHref != null;

  async function request() {
    setRequesting(true);
    try {
      await apiFetch("/requests", {
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
      toast.success("Requested");
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

  return (
    <div className="group w-full">
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        {item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.poster} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-800 px-2 text-center text-xs text-zinc-600">
            No poster
          </div>
        )}

        {/* Top-left media type */}
        <Badge tone="accent" className="absolute left-1.5 top-1.5 uppercase tracking-wide">
          {item.mediaType === "movie" ? "Movie" : "Series"}
        </Badge>

        {/* Top-right availability corner */}
        {status === "available" && (
          <Badge tone="success" className="absolute right-1.5 top-1.5" aria-label="In library">
            ✓
          </Badge>
        )}
        {status === "requested" && (
          <Badge tone="warning" className="absolute right-1.5 top-1.5">
            Requested
          </Badge>
        )}

        {/* Hover overlay with the primary action */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {canPlay && (
            <>
              <Button size="sm" onClick={() => setPlaying(true)}>
                ▶ Play
              </Button>
              {detailHref && (
                <Link href={detailHref}>
                  <Button variant="secondary" size="sm">
                    Details
                  </Button>
                </Link>
              )}
            </>
          )}

          {canWatch && detailHref && (
            <>
              <Link href={detailHref}>
                <Button size="sm">Watch</Button>
              </Link>
              <Link href={detailHref}>
                <Button variant="secondary" size="sm">
                  Details
                </Button>
              </Link>
            </>
          )}

          {status === "requested" && (
            <>
              <Button variant="secondary" size="sm" disabled>
                Requested
              </Button>
              {detailHref && (
                <Link href={detailHref}>
                  <Button variant="ghost" size="sm">
                    Details
                  </Button>
                </Link>
              )}
            </>
          )}

          {status === "unavailable" && (
            <Button size="sm" loading={requesting} onClick={request}>
              Request
            </Button>
          )}
        </div>
      </div>

      <div className="mt-1.5">
        <div className="truncate text-sm font-medium text-zinc-200" title={item.title}>
          {item.title}
        </div>
        {item.year != null && <div className="text-xs text-zinc-500">({item.year})</div>}
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
