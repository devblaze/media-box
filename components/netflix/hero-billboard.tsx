"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui";
import { VideoPlayerModal } from "@/components/media-player";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/**
 * Full-bleed Netflix hero. The backdrop covers the section; a left-to-right and a
 * bottom-to-top #141414 gradient keep the bottom-left content readable and blend
 * the hero into the rows below. Actions mirror PosterCard's availability logic.
 */
export function HeroBillboard({ item }: { item: DiscoverItem }) {
  const toast = useToast();
  const [status, setStatus] = useState(item.status);
  const [requesting, setRequesting] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Branded title-logo (transparent PNG) fetched on mount; falls back to text.
  const [logo, setLogo] = useState<string | null>(null);

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

  const playBtn =
    "inline-flex items-center gap-2 rounded bg-white px-6 py-2 text-base font-semibold text-black transition-colors hover:bg-white/80";

  return (
    <section className="relative h-[80vh] min-h-[500px] w-full">
      {/* Background */}
      {item.backdrop ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.backdrop}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      ) : item.poster ? (
        <div className="absolute inset-0 flex items-center justify-end bg-zinc-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.poster}
            alt=""
            className="h-full w-auto max-w-[55%] object-cover opacity-70"
          />
        </div>
      ) : (
        <div className="absolute inset-0 bg-zinc-900" />
      )}

      {/* Readability gradients */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/60 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#141414] to-transparent" />

      {/* Content */}
      <div className="absolute bottom-28 left-0 w-full max-w-2xl px-4 md:bottom-36 md:px-12">
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
    </section>
  );
}
