"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { PlayButton, useInstantPlay } from "./instant-play";
import { detailHrefFor, useRequestTitle } from "./use-request-title";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/**
 * A landscape (16:9) title card. Two things to do with it, each one obvious:
 *   - the card itself opens the title's details page (in-library titles);
 *   - the ▶ button plays it right away: a movie from where you left off, a series
 *     from the episode that's next for you.
 * Titles not in the library get a Request button in place of ▶.
 *
 * Hover lifts the card in place rather than blowing it up over its neighbours,
 * so rows need no extra room and nothing gets clipped at a screen edge. The
 * wrapper is `w-full`: rows and grids decide the width.
 */
export function TitleCard({ item }: { item: DiscoverItem }) {
  const { status, requesting, request } = useRequestTitle(item);
  const { play, starting, player } = useInstantPlay();

  const detailHref = detailHrefFor(item);
  const playable = status === "available" && item.mediaId != null;
  const image = item.backdrop ?? item.poster;
  const kind = item.mediaType === "movie" ? "Movie" : "Series";

  return (
    <div className="group relative w-full">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-900 shadow-lg ring-1 ring-white/10 transition duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-2xl group-hover:shadow-black/60 group-hover:ring-white/30 group-focus-within:ring-white/40">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 px-4 text-center text-sm font-medium text-zinc-400">
            {item.title}
          </div>
        )}

        {/* Readability: the title sits on the bottom of the artwork. */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

        <StatusPill status={status} />

        {/* The whole card opens the details page. The ▶ / Request buttons sit
            above this link, not inside it, so each click does one thing. */}
        {detailHref && (
          <Link
            href={detailHref}
            aria-label={`${item.title} — details`}
            className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none"
          >
            <span className="absolute top-2.5 right-2.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 ring-1 ring-white/20 backdrop-blur transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
              Details
            </span>
          </Link>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end gap-3 p-3 sm:p-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-white drop-shadow sm:text-lg">
              {item.title}
            </h3>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-300">
              {item.year != null && <span>{item.year}</span>}
              {item.year != null && <span className="text-zinc-500">·</span>}
              <span>{kind}</span>
            </p>
          </div>

          {playable && (
            <PlayButton
              title={item.title}
              busy={starting}
              onClick={() =>
                void play({ mediaType: item.mediaType, mediaId: item.mediaId!, title: item.title })
              }
              className="pointer-events-auto"
            />
          )}
          {status === "unavailable" && (
            <button
              type="button"
              onClick={request}
              disabled={requesting}
              aria-label={`Request ${item.title}`}
              className="pointer-events-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3.5 text-sm font-semibold text-white ring-1 ring-white/30 backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-50"
            >
              <span aria-hidden className="text-base leading-none">
                +
              </span>
              Request
            </button>
          )}
        </div>
      </div>

      {player}
    </div>
  );
}

/** Top-left availability marker: green when it's yours to watch, amber when asked for. */
function StatusPill({ status }: { status: DiscoverItem["status"] }) {
  if (status === "unavailable") return null;
  const available = status === "available";
  return (
    <span
      className={cn(
        "pointer-events-none absolute top-2.5 left-2.5 z-20 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold shadow backdrop-blur",
        available ? "bg-emerald-500/90 text-black" : "bg-amber-500/90 text-black"
      )}
    >
      {available && <span className="size-1.5 rounded-full bg-black/70" />}
      {available ? "Ready to watch" : "Requested"}
    </span>
  );
}
