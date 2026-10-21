"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { Spinner } from "@/components/ui";
import { useInstantPlay } from "./instant-play";
import { detailHrefFor, useRequestTitle } from "./use-request-title";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/** How long each title stays on screen before crossfading to the next. */
const ROTATE_MS = 7000;

/**
 * Full-bleed Netflix hero that rotates through a list of candidates, crossfading
 * the backdrop every {@link ROTATE_MS}. Every candidate's backdrop is layered and
 * only the current one is opaque, so advancing the index fades the new one in over
 * the old. The foreground (logo/meta/actions) is a child keyed by the current
 * title, so its per-item state — status, logo fetch, request/play — resets cleanly
 * on each change, exactly mirroring the old single-item behavior.
 *
 * The parent passes a non-empty list (it renders a gradient fallback when there are
 * no candidates), so we can safely assume `items.length >= 1`.
 */
export function HeroBillboard({ items }: { items: DiscoverItem[] }) {
  const [index, setIndex] = useState(0);

  // Advance on a timer. Reset to the first slide and rebuild the interval whenever
  // the candidate list identity changes (e.g. availableOnly toggled). A single
  // candidate never rotates.
  useEffect(() => {
    setIndex(0);
    if (items.length <= 1) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [items]);

  // Clamp so a shrinking list can never index out of range for a render.
  const current = index < items.length ? index : items.length - 1;
  const item = items[current];

  return (
    <section className="relative h-[80vh] min-h-[500px] w-full bg-zinc-900">
      {/* Crossfading backdrops: every candidate is layered; only the current is
          opaque, so index changes fade the new backdrop in over the old. */}
      {items.map((it, i) =>
        it.backdrop ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${it.mediaType}-${it.tmdbId}`}
            src={it.backdrop}
            alt=""
            aria-hidden={i !== current}
            className={
              "absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-700 ease-in-out " +
              (i === current ? "opacity-100" : "opacity-0")
            }
          />
        ) : null
      )}

      {/* Readability gradients */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/60 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#141414] to-transparent" />

      {/* Foreground content, keyed so all per-item state resets on rotation. */}
      <HeroContent key={`${item.mediaType}-${item.tmdbId}`} item={item} />

      {/* Dot indicators, clickable to jump to a title. */}
      {items.length > 1 && (
        <div className="absolute right-4 bottom-28 z-10 hidden items-center gap-2 sm:flex md:bottom-36 md:right-12">
          {items.map((it, i) => (
            <button
              key={`${it.mediaType}-${it.tmdbId}`}
              type="button"
              aria-label={`Show ${it.title}`}
              aria-current={i === current}
              onClick={() => setIndex(i)}
              className={
                "h-1.5 rounded-full transition-all " +
                (i === current ? "w-6 bg-white" : "w-3 bg-white/40 hover:bg-white/70")
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The bottom-left content for one hero title: branded logo (fetched per tmdbId,
 * falling back to text), meta, overview, and the Play / Request / Details
 * actions. Play starts the title right here — a series at the episode that's next
 * for this viewer. Mounted with a fresh key per title, so status, logo and the
 * player all re-initialize for the shown item.
 */
function HeroContent({ item }: { item: DiscoverItem }) {
  const { status, requesting, request } = useRequestTitle(item);
  const { play, starting, player } = useInstantPlay();
  // Branded title-logo (transparent PNG) fetched on mount; falls back to text.
  const [logo, setLogo] = useState<string | null>(null);
  // Fade the text in on mount so each rotation swap is a soft cross-fade.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    let active = true;
    const type = item.mediaType === "series" ? "series" : "movie";
    apiFetch<{ logo: string | null }>(`/discover/logo?type=${type}&tmdbId=${item.tmdbId}`)
      .then((res) => {
        if (active) setLogo(res.logo);
      })
      .catch(() => {
        if (active) setLogo(null);
      });
    return () => {
      active = false;
    };
  }, [item.mediaType, item.tmdbId]);

  const detailHref = detailHrefFor(item);
  const playable = status === "available" && item.mediaId != null;

  const availabilityLabel =
    status === "available"
      ? "Ready to watch"
      : status === "requested"
        ? "Requested"
        : "Not in library";

  const button =
    "inline-flex h-12 items-center gap-2.5 rounded-full px-7 text-base font-semibold transition-all duration-200 active:scale-95";

  return (
    <>
      <div
        className={
          "absolute bottom-28 left-0 w-full max-w-2xl px-4 transition-opacity duration-500 md:bottom-36 md:px-12 " +
          (shown ? "opacity-100" : "opacity-0")
        }
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt={item.title}
            loading="lazy"
            className="max-h-32 w-auto max-w-[70%] object-contain drop-shadow-xl md:max-h-40"
          />
        ) : (
          <h1 className="text-4xl font-extrabold tracking-tight text-white drop-shadow-lg md:text-6xl">
            {item.title}
          </h1>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-300">
          {item.year != null && <span>{item.year}</span>}
          {item.year != null && <span className="text-zinc-600">·</span>}
          <span className="uppercase tracking-wide">
            {item.mediaType === "movie" ? "Movie" : "Series"}
          </span>
          <span className="text-zinc-600">·</span>
          <span
            className={
              status === "available"
                ? "text-emerald-400"
                : status === "requested"
                  ? "text-amber-400"
                  : "text-zinc-400"
            }
          >
            {availabilityLabel}
          </span>
        </div>

        {item.overview && (
          <p className="mt-4 line-clamp-3 max-w-xl text-sm text-zinc-200 drop-shadow md:text-base">
            {item.overview}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {playable && (
            <button
              type="button"
              onClick={() =>
                void play({ mediaType: item.mediaType, mediaId: item.mediaId!, title: item.title })
              }
              disabled={starting}
              className={`${button} bg-white text-black shadow-lg shadow-black/40 hover:bg-white/85 disabled:cursor-wait`}
            >
              {starting ? (
                <Spinner className="size-5" />
              ) : (
                <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
                  <path d="M7 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" />
                </svg>
              )}
              Play
            </button>
          )}
          {status === "unavailable" && (
            <button
              type="button"
              onClick={request}
              disabled={requesting}
              className={`${button} bg-white/20 text-white ring-1 ring-white/30 backdrop-blur hover:bg-white/30 disabled:opacity-60`}
            >
              <span aria-hidden className="text-xl leading-none">
                +
              </span>
              Request
            </button>
          )}
          {status === "requested" && (
            <span className={`${button} bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40`}>
              ✓ Requested
            </span>
          )}
          {detailHref && (
            <Link
              href={detailHref}
              className={`${button} bg-zinc-500/40 text-white ring-1 ring-white/15 backdrop-blur hover:bg-zinc-500/55`}
            >
              <svg
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
              Details
            </Link>
          )}
        </div>
      </div>

      {player}
    </>
  );
}
