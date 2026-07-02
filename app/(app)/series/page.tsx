"use client";

import Link from "next/link";
import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { tmdbPoster, type SeriesSummary } from "@/lib/types";
import { Button, Badge, EmptyState, Skeleton } from "@/components/ui";

export default function SeriesPage() {
  const { data } = useApi<SeriesSummary[]>("/series");
  useEvents();

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Series</h1>
        <Link href="/add">
          <Button size="sm">Add series</Button>
        </Link>
      </div>

      {!data ? (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rounded border border-zinc-800 bg-zinc-900/50 p-2">
              <Skeleton className="aspect-[2/3] w-full" />
              <Skeleton className="mt-2 h-4 w-3/4" />
              <Skeleton className="mt-2 h-1 w-full" />
            </div>
          ))}
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="Library is empty"
          description="Add a series, or migrate from Sonarr under Settings → Migrate."
          action={
            <Link href="/add">
              <Button size="sm">Add series</Button>
            </Link>
          }
        />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {data.map((s) => {
            const poster = tmdbPoster(s.posterPath);
            const pct = s.episodeCount > 0 ? Math.round((s.episodeFileCount / s.episodeCount) * 100) : 0;
            return (
              <Link
                key={s.id}
                href={`/series/${s.id}`}
                className="group rounded border border-zinc-800 bg-zinc-900/50 p-2 hover:border-amber-500/60"
              >
                {poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={poster} alt="" className="aspect-[2/3] w-full rounded object-cover" />
                ) : (
                  <div className="aspect-[2/3] w-full rounded bg-zinc-800" />
                )}
                <div className="mt-2 truncate text-sm font-medium group-hover:text-amber-300">
                  {s.title}
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
                  <span>{s.year ?? "—"}</span>
                  <Badge tone={s.monitored ? "accent" : "neutral"}>
                    {s.episodeFileCount}/{s.episodeCount}
                  </Badge>
                </div>
                <div className="mt-1 h-1 rounded bg-zinc-800">
                  <div
                    className={`h-1 rounded ${pct === 100 ? "bg-green-500" : "bg-amber-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
