"use client";

import Link from "next/link";
import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { tmdbPoster, type MovieSummary } from "@/lib/types";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";

export default function MoviesPage() {
  const { data } = useApi<MovieSummary[]>("/movies");
  useEvents();

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Movies</h1>
        <Link href="/add">
          <Button size="sm">Add movie</Button>
        </Link>
      </div>

      {!data ? (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rounded border border-zinc-800 bg-zinc-900/50 p-2">
              <Skeleton className="aspect-[2/3] w-full" />
              <Skeleton className="mt-2 h-4 w-3/4" />
              <Skeleton className="mt-1 h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="Library is empty"
          description="Add a movie, or migrate from Radarr under Settings → Migrate."
          action={
            <Link href="/add">
              <Button size="sm">Add movie</Button>
            </Link>
          }
        />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {data.map((m) => {
            const poster = tmdbPoster(m.posterPath);
            return (
              <Link
                key={m.id}
                href={`/movies/${m.id}`}
                className="group rounded border border-zinc-800 bg-zinc-900/50 p-2 hover:border-amber-500/60"
              >
                {poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={poster} alt="" className="aspect-[2/3] w-full rounded object-cover" />
                ) : (
                  <div className="aspect-[2/3] w-full rounded bg-zinc-800" />
                )}
                <div className="mt-2 truncate text-sm font-medium group-hover:text-amber-300">
                  {m.title}
                </div>
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className="text-zinc-500">{m.year ?? "—"}</span>
                  <Badge tone={m.movieFileId ? "success" : "warning"}>
                    {m.movieFileId ? "Downloaded" : "Missing"}
                  </Badge>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
