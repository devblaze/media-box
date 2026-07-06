"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import {
  Button,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Table,
  TBody,
  TR,
  TD,
  EmptyState,
  Skeleton,
  useToast,
} from "@/components/ui";

interface WantedData {
  episodes: {
    episodeId: number;
    seriesId: number;
    seriesTitle: string;
    seasonNumber: number;
    episodeNumber: number;
    episodeTitle: string | null;
    airDateUtc: number | string | null;
  }[];
  movies: {
    movieId: number;
    title: string;
    year: number | null;
    status: string;
  }[];
}

export default function WantedPage() {
  const { data, mutate } = useApi<WantedData>("/wanted");
  const toast = useToast();
  const [searching, setSearching] = useState(false);
  useEvents();

  async function searchAll() {
    setSearching(true);
    try {
      await apiFetch("/command", { method: "POST", body: JSON.stringify({ name: "WantedSearch" }) });
      toast.success("Search for all missing items started.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start search.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="max-w-4xl px-4 py-6 md:px-12">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Wanted</h1>
        <Button size="sm" onClick={searchAll} loading={searching}>
          Search all missing
        </Button>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Missing episodes</CardTitle>
          {data ? <Badge tone="neutral">{data.episodes.length}</Badge> : null}
        </CardHeader>
        <CardBody>
          {!data ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-5/6" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : data.episodes.length === 0 ? (
            <EmptyState
              icon="🎉"
              title="No missing episodes"
              description="Everything you're monitoring has been downloaded."
            />
          ) : (
            <Table>
              <TBody>
                {data.episodes.map((e) => (
                  <TR key={e.episodeId}>
                    <TD>
                      <Link href={`/series/${e.seriesId}`} className="hover:text-amber-300">
                        {e.seriesTitle}
                      </Link>
                    </TD>
                    <TD className="w-24 font-mono text-xs text-zinc-400">
                      S{String(e.seasonNumber).padStart(2, "0")}E{String(e.episodeNumber).padStart(2, "0")}
                    </TD>
                    <TD>{e.episodeTitle ?? "TBA"}</TD>
                    <TD className="w-28 text-right text-xs text-zinc-500">
                      {e.airDateUtc ? new Date(e.airDateUtc).toLocaleDateString() : "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Missing movies</CardTitle>
          {data ? <Badge tone="neutral">{data.movies.length}</Badge> : null}
        </CardHeader>
        <CardBody>
          {!data ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : data.movies.length === 0 ? (
            <EmptyState title="No missing movies" />
          ) : (
            <Table>
              <TBody>
                {data.movies.map((m) => (
                  <TR key={m.movieId}>
                    <TD>
                      <Link href={`/movies/${m.movieId}`} className="hover:text-amber-300">
                        {m.title} {m.year ? <span className="text-zinc-500">({m.year})</span> : null}
                      </Link>
                    </TD>
                    <TD className="w-28 text-right">
                      <Badge tone="neutral">{m.status}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
