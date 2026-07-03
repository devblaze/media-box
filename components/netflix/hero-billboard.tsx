"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui";
import { VideoPlayerModal } from "@/components/media-player";
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
        <div className="absolute bottom-28 right-4 z-10 flex items-center gap-2 md:bottom-36 md:right-12">
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
 * falling back to text), meta, overview, and the Play/Request/More Info actions.
 * Mounted with a fresh key per title, so `status`, `logo`, `requesting`, and
 * `playing` all re-initialize for the shown item. Actions mirror PosterCard's
 * availability logic.
 */
function HeroContent({ item }: { item: DiscoverItem }) {
  const toast = useToast();
  const [status, setStatus] = useState(item.status);
  const [requesting, setRequesting] = useState(false);
  const [playing, setPlaying] = useState(false);
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

  const detailHref =
    item.mediaId != null
      ? item.mediaType === "movie"
        ? `/movies/${item.mediaId}`
        : `/series/${item.mediaId}`
      : null;

  const canPlayMovie = status === "available" && item.mediaType === "movie" && item.mediaId != null;
  const canWatchSeries = status === "available" && item.mediaType === "series" && detailHref != null;

  const availabilityLabel =
    status === "available" ? "In your library" : status === "requested" ? "Requested" : "Not in library";

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

  const playBtn =
    "inline-flex items-center gap-2 rounded bg-white px-6 py-2 text-base font-semibold text-black transition-colors hover:bg-white/80";

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
          {canPlayMovie && (
            <button type="button" onClick={() => setPlaying(true)} className={playBtn}>
              <span aria-hidden>▶</span> Play
            </button>
          )}
          {canWatchSeries && detailHref && (
            <Link href={detailHref} className={playBtn}>
              <span aria-hidden>▶</span> Play
            </Link>
          )}
          {status === "unavailable" && (
            <button
              type="button"
              onClick={request}
              disabled={requesting}
              className="inline-flex items-center gap-2 rounded bg-white/20 px-6 py-2 text-base font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/30 disabled:opacity-60"
            >
              <span aria-hidden>＋</span> Request
            </button>
          )}
          {status === "requested" && (
            <span className="inline-flex items-center gap-2 rounded bg-amber-500/20 px-6 py-2 text-base font-semibold text-amber-300">
              ✓ Requested
            </span>
          )}
          {detailHref && (
            <Link
              href={detailHref}
              className="inline-flex items-center gap-2 rounded bg-zinc-500/40 px-6 py-2 text-base font-semibold text-white backdrop-blur-sm transition-colors hover:bg-zinc-500/30"
            >
              <span aria-hidden>ⓘ</span> More Info
            </Link>
          )}
        </div>
      </div>

      {playing && item.mediaId != null && (
        <VideoPlayerModal
          target={{ type: "movie", id: item.mediaId }}
          title={item.title}
          onClose={() => setPlaying(false)}
        />
      )}
    </>
  );
}
