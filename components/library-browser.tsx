"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useEvents } from "@/lib/use-events";
import { tmdbPoster, type MovieSummary, type SeriesSummary } from "@/lib/types";
import { Button, EmptyState } from "@/components/ui";
import { PlayButton, useInstantPlay } from "@/components/netflix/instant-play";

type Kind = "movies" | "series";
type Filter = "all" | "ready" | "missing";
type Sort = "added" | "title" | "year";

/** One title in the grid, whichever list it came from. */
type Entry = {
  id: number;
  title: string;
  sortTitle: string;
  year: number | null;
  poster: string | null;
  /** Newest of added / last imported: what "Recently added" orders by. */
  addedAt: number;
  /** Something is downloaded, so ▶ has something to play. */
  ready: boolean;
  /** Series only: episodes downloaded of those known. */
  episodes?: { have: number; total: number };
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready to watch" },
  { id: "missing", label: "Not downloaded" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "added", label: "Recently added" },
  { id: "title", label: "Title A–Z" },
  { id: "year", label: "Newest first" },
];

function fromMovie(m: MovieSummary): Entry {
  return {
    id: m.id,
    title: m.title,
    sortTitle: m.sortTitle || m.title.toLowerCase(),
    year: m.year,
    poster: tmdbPoster(m.posterPath),
    addedAt: Math.max(m.addedAt ?? 0, m.importedAt ?? 0),
    ready: m.movieFileId != null,
  };
}

function fromSeries(s: SeriesSummary): Entry {
  return {
    id: s.id,
    title: s.title,
    sortTitle: s.sortTitle || s.title.toLowerCase(),
    year: s.year,
    poster: tmdbPoster(s.posterPath),
    addedAt: Math.max(s.addedAt ?? 0, s.importedAt ?? 0),
    ready: s.episodeFileCount > 0,
    episodes: { have: s.episodeFileCount, total: s.episodeCount },
  };
}

/**
 * The library: every movie or series media-box has, as a poster grid. A poster
 * opens the title's page; its ▶ plays it at once (a series at the episode that's
 * next for you). Tabs switch between movies and series; search, a ready /
 * not-downloaded filter and a sort narrow it down.
 */
export function LibraryBrowser({ kind }: { kind: Kind }) {
  const movies = useApi<MovieSummary[]>("/movies");
  const series = useApi<SeriesSummary[]>("/series");
  const { data: me } = useApi<{ role: "admin" | "user" }>("/auth/me");
  useEvents();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("added");

  const source = kind === "movies" ? movies.data : series.data;
  const entries = useMemo(
    () =>
      source === undefined
        ? undefined
        : kind === "movies"
          ? (source as MovieSummary[]).map(fromMovie)
          : (source as SeriesSummary[]).map(fromSeries),
    [source, kind]
  );

  const shown = useMemo(() => {
    if (!entries) return undefined;
    const q = query.trim().toLowerCase();
    const list = entries.filter(
      (e) =>
        (!q || e.title.toLowerCase().includes(q)) &&
        (filter === "all" || (filter === "ready" ? e.ready : !e.ready))
    );
    return list.sort((a, b) =>
      sort === "title"
        ? a.sortTitle.localeCompare(b.sortTitle)
        : sort === "year"
          ? (b.year ?? 0) - (a.year ?? 0) || a.sortTitle.localeCompare(b.sortTitle)
          : b.addedAt - a.addedAt
    );
  }, [entries, query, filter, sort]);

  const noun = kind === "movies" ? "movie" : "series";

  return (
    <div className="px-4 pt-6 pb-16 md:px-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Library</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Everything on your server. Press ▶ to start watching.
          </p>
        </div>
        {me?.role === "admin" && (
          <Link href="/add">
            <Button size="sm">Add {noun}</Button>
          </Link>
        )}
      </div>

      {/* Movies | Series */}
      <div className="mt-6 inline-flex rounded-full bg-white/5 p-1 ring-1 ring-white/10">
        {(["movies", "series"] as const).map((k) => {
          const count = (k === "movies" ? movies.data : series.data)?.length;
          return (
            <Link
              key={k}
              href={`/${k}`}
              aria-current={k === kind ? "page" : undefined}
              className={cn(
                "rounded-full px-5 py-1.5 text-sm font-semibold transition-colors",
                k === kind ? "bg-white text-black" : "text-zinc-300 hover:text-white"
              )}
            >
              {k === "movies" ? "Movies" : "Series"}
              {count != null && (
                <span
                  className={cn("ml-1 font-normal", k === kind ? "text-zinc-600" : "text-zinc-500")}
                >
                  {" "}
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Search · filter · sort */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 basis-60 sm:max-w-sm">
          <span className="sr-only">Search the library</span>
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-500"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${kind === "movies" ? "movies" : "series"}`}
            className="h-10 w-full rounded-full bg-white/5 pr-4 pl-10 text-sm text-white ring-1 ring-white/10 outline-none transition placeholder:text-zinc-500 focus:bg-white/10 focus:ring-white/30"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={cn(
                "h-10 rounded-full px-4 text-sm font-medium ring-1 transition-colors",
                filter === f.id
                  ? "bg-white text-black ring-white"
                  : "text-zinc-300 ring-white/15 hover:bg-white/10"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <label className="ml-auto flex items-center gap-2 text-sm text-zinc-400">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="h-10 rounded-full bg-white/5 px-4 text-sm text-white ring-1 ring-white/10 outline-none focus:ring-white/30"
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id} className="bg-zinc-900">
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-8">
        {shown === undefined ? (
          <div className={GRID}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i}>
                <div className="aspect-[2/3] animate-pulse rounded-xl bg-zinc-800/80" />
                <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-zinc-800/80" />
              </div>
            ))}
          </div>
        ) : entries?.length === 0 ? (
          <EmptyState
            title={`No ${kind === "movies" ? "movies" : "series"} yet`}
            description={
              me?.role === "admin"
                ? `Add a ${noun}, or migrate from ${kind === "movies" ? "Radarr" : "Sonarr"} under Manage → Migrate.`
                : "Find something on Home and request it — it shows up here once it's added."
            }
            action={
              me?.role === "admin" ? (
                <Link href="/add">
                  <Button size="sm">Add {noun}</Button>
                </Link>
              ) : undefined
            }
          />
        ) : shown.length === 0 ? (
          <p className="py-12 text-center text-zinc-400">
            Nothing matches — try another search or filter.
          </p>
        ) : (
          <div className={GRID}>
            {shown.map((e) => (
              <LibraryCard key={e.id} entry={e} kind={kind} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const GRID =
  "grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6";

/** A poster: the art opens the title's page, ▶ plays it. */
function LibraryCard({ entry, kind }: { entry: Entry; kind: Kind }) {
  const { play, starting, player } = useInstantPlay();
  const href = `/${kind}/${entry.id}`;
  const pct =
    entry.episodes && entry.episodes.total > 0
      ? Math.round((entry.episodes.have / entry.episodes.total) * 100)
      : null;

  return (
    <div className="group">
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-zinc-900 shadow-lg ring-1 ring-white/10 transition duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-2xl group-hover:shadow-black/60 group-hover:ring-white/30 group-focus-within:ring-white/40">
        {entry.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.poster}
            alt=""
            loading="lazy"
            className={cn(
              "h-full w-full object-cover transition duration-500 ease-out group-hover:scale-105",
              !entry.ready && "opacity-50 grayscale-[60%]"
            )}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 px-3 text-center text-sm font-medium text-zinc-400">
            {entry.title}
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/80 to-transparent" />

        {!entry.ready && (
          <span className="pointer-events-none absolute top-2.5 left-2.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-zinc-200 ring-1 ring-white/15 backdrop-blur">
            Not downloaded
          </span>
        )}

        <Link
          href={href}
          aria-label={`${entry.title} — details`}
          className="absolute inset-0 z-10 focus-visible:outline-none"
        />

        {entry.ready && (
          <PlayButton
            title={entry.title}
            busy={starting}
            onClick={() =>
              void play({
                mediaType: kind === "movies" ? "movie" : "series",
                mediaId: entry.id,
                title: entry.title,
              })
            }
            className="absolute right-3 bottom-3 z-20"
          />
        )}

        {/* Series: how much of it is downloaded. */}
        {pct != null && pct < 100 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-white/15">
            <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <Link href={href} className="mt-3 block">
        <span className="block truncate text-sm font-semibold text-zinc-100 transition-colors group-hover:text-white">
          {entry.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
          {entry.year != null && <span>{entry.year}</span>}
          {entry.episodes && (
            <>
              {entry.year != null && <span>·</span>}
              <span>
                {entry.episodes.have}/{entry.episodes.total} episodes
              </span>
            </>
          )}
        </span>
      </Link>

      {player}
    </div>
  );
}
