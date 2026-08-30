"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import { Calendar, dayKey, getCalendarDays } from "@/components/calendar";
import { ReleaseSearchDrawer, type SearchScope } from "@/components/release-search";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "@/components/ui";

interface QualityDefinition {
  id: number;
  name: string;
}

type Stage = "grab" | "download" | "fetch" | "import";
type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/** One failed grab/download/import attempt from `GET /api/v1/history/failures`. */
interface FailureRow {
  id: number;
  date: number | string;
  mediaType: "series" | "movie";
  seriesId: number | null;
  movieId: number | null;
  episodeId: number | null;
  seriesTitle: string | null;
  movieTitle: string | null;
  sourceTitle: string;
  quality: { qualityId: number; revision?: { version: number; real: number } } | null;
  data: { reason: string; stage: Stage; seasonNumber: number | null };
}

/** One successful grab/import from `GET /api/v1/history/downloads`. */
interface SuccessRow {
  id: number;
  date: number | string;
  eventType: "grabbed" | "imported";
  mediaType: "series" | "movie";
  seriesId: number | null;
  movieId: number | null;
  episodeId: number | null;
  seriesTitle: string | null;
  movieTitle: string | null;
  sourceTitle: string;
  quality: { qualityId: number; revision?: { version: number; real: number } } | null;
}

/** Distinct tone per pipeline stage so the eye can scan a day's failures fast. */
const STAGE_TONE: Record<Stage, BadgeTone> = {
  grab: "info",
  download: "accent",
  fetch: "warning",
  import: "danger",
};

/** film vs. tv glyph, so a row reads as movie/series at a glance. */
function MediaIcon({ mediaType }: { mediaType: "series" | "movie" }) {
  if (mediaType === "movie") {
    return (
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2.5" y="4" width="19" height="16" rx="2" />
        <path d="M7 4v16M17 4v16M2.5 9h4.5M2.5 15h4.5M17 9h4.5M17 15h4.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2.5" y="7" width="19" height="13" rx="2" />
      <path d="m8 3 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Rebuild the interactive-search target for a failed row, preferring the most
 * specific scope the row can support: a movie, else a single episode, else a
 * season pack (needs both the series and the resolved season). Returns null when
 * none can be reconstructed — e.g. a series-level failure with no season.
 */
function reconstructScope(row: FailureRow): { scope: SearchScope; title: string } | null {
  const title = row.movieTitle ?? row.seriesTitle ?? row.sourceTitle;
  if (row.movieId != null) return { scope: { movieId: row.movieId }, title };
  if (row.episodeId != null) return { scope: { episodeId: row.episodeId }, title };
  if (row.seriesId != null && row.data.seasonNumber != null) {
    return { scope: { seriesId: row.seriesId, season: row.data.seasonNumber }, title };
  }
  return null;
}

export default function FailuresPage() {
  const [month, setMonth] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const [search, setSearch] = useState<{ scope: SearchScope; title: string } | null>(null);

  // The grid's visible days are the single source of truth for the fetch window,
  // so navigating months re-fetches exactly the range on screen.
  const days = useMemo(() => getCalendarDays(month), [month]);
  const first = days[0];
  const last = days[days.length - 1];
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate()).toISOString();
  const end = new Date(
    last.getFullYear(),
    last.getMonth(),
    last.getDate(),
    23,
    59,
    59,
    999
  ).toISOString();

  // SWR key includes the window, so a month change refetches automatically.
  const { data: failures, mutate } = useApi<FailureRow[]>(
    `/history/failures?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  );
  const { data: successes } = useApi<SuccessRow[]>(
    `/history/downloads?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  );
  const { data: qualityDefs } = useApi<QualityDefinition[]>("/qualitydefinitions");

  const qualityNames = useMemo(
    () => new Map((qualityDefs ?? []).map((q) => [q.id, q.name] as const)),
    [qualityDefs]
  );

  // Group failures by local calendar day so buckets line up with grid cells.
  const byDay = useMemo(() => {
    const map = new Map<string, FailureRow[]>();
    for (const row of failures ?? []) {
      const key = dayKey(new Date(row.date));
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return map;
  }, [failures]);

  const successByDay = useMemo(() => {
    const map = new Map<string, SuccessRow[]>();
    for (const row of successes ?? []) {
      const key = dayKey(new Date(row.date));
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return map;
  }, [successes]);

  const selectedFailures = byDay.get(dayKey(selectedDay)) ?? [];
  const selectedSuccesses = successByDay.get(dayKey(selectedDay)) ?? [];

  /**
   * Episodes grabbed more than once on the selected day. An RSS feed lists the
   * same episode once per release group, so a duplicate storm here means several
   * releases raced for one episode and the last to import won — which is how an
   * unwanted language ends up replacing a good file.
   */
  const duplicateGrabs = useMemo(() => {
    const byEpisode = new Map<number, SuccessRow[]>();
    for (const row of selectedSuccesses) {
      if (row.eventType !== "grabbed" || row.episodeId == null) continue;
      const bucket = byEpisode.get(row.episodeId);
      if (bucket) bucket.push(row);
      else byEpisode.set(row.episodeId, [row]);
    }
    return [...byEpisode.values()].filter((rows) => rows.length > 1);
  }, [selectedSuccesses]);

  const loading = failures === undefined;
  const dayLabel = selectedDay.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold">Download activity</h1>
      <p className="mt-1 text-sm text-zinc-400">
        What was grabbed and imported, and what failed — click a day to inspect,
        spot duplicate grabs, and re-search.
      </p>

      <div className="mt-6">
        <Calendar
          month={month}
          onMonthChange={setMonth}
          selectedDay={selectedDay}
          onDayClick={setSelectedDay}
          renderDay={(day) => {
            const failed = byDay.get(dayKey(day))?.length ?? 0;
            const ok = successByDay.get(dayKey(day))?.length ?? 0;
            if (!failed && !ok) return null;
            return (
              <div className="flex w-full flex-col gap-0.5">
                {ok > 0 && (
                  <Badge tone="success" className="w-full justify-center">
                    {ok} ok
                  </Badge>
                )}
                {failed > 0 && (
                  <Badge tone="danger" className="w-full justify-center">
                    {failed} failed
                  </Badge>
                )}
              </div>
            );
          }}
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{dayLabel}</CardTitle>
          <div className="flex gap-2">
            {selectedSuccesses.length > 0 && (
              <Badge tone="success">{selectedSuccesses.length} succeeded</Badge>
            )}
            {selectedFailures.length > 0 && (
              <Badge tone="danger">
                {selectedFailures.length} {selectedFailures.length === 1 ? "failure" : "failures"}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : selectedFailures.length === 0 && selectedSuccesses.length === 0 ? (
            <EmptyState
              title="Nothing happened on this day"
              description="Pick a day with a badge to see what was downloaded and what went wrong."
            />
          ) : (
            <div className="space-y-5">
              {duplicateGrabs.length > 0 && (
                <div className="rounded-lg border border-yellow-500/25 bg-yellow-500/5 p-3 text-sm">
                  <p className="font-medium text-yellow-200">
                    {duplicateGrabs.length} episode{duplicateGrabs.length === 1 ? "" : "s"} grabbed
                    more than once on this day
                  </p>
                  <p className="mt-1 text-zinc-400">
                    Several releases raced for the same episode — the last one to import wins, which
                    is how an unwanted cut or language can replace a good file.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {duplicateGrabs.map((rows) => (
                      <li key={rows[0].episodeId} className="font-mono text-xs text-zinc-400">
                        {rows.length}× {rows[0].seriesTitle ?? rows[0].sourceTitle}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedSuccesses.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Succeeded
                  </h3>
                  <ul className="space-y-2">
                    {selectedSuccesses.map((row) => {
                      const title = row.movieTitle ?? row.seriesTitle ?? row.sourceTitle;
                      const qualityName =
                        row.quality?.qualityId != null
                          ? qualityNames.get(row.quality.qualityId)
                          : undefined;
                      return (
                        <li
                          key={`s${row.id}`}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="shrink-0 text-zinc-400">
                              <MediaIcon mediaType={row.mediaType} />
                            </span>
                            <span className="min-w-0 truncate font-medium text-zinc-100">
                              {title}
                            </span>
                            <Badge tone={row.eventType === "imported" ? "success" : "info"}>
                              {row.eventType === "imported" ? "Imported" : "Grabbed"}
                            </Badge>
                            {qualityName && <Badge tone="neutral">{qualityName}</Badge>}
                          </div>
                          <p
                            className="mt-1 truncate font-mono text-xs text-zinc-500"
                            title={row.sourceTitle}
                          >
                            {row.sourceTitle}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">
                            {new Date(row.date).toLocaleTimeString()}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {selectedFailures.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Failed
                  </h3>
                  <ul className="space-y-3">
              {selectedFailures.map((row) => {
                const reconstructed = reconstructScope(row);
                const title = row.movieTitle ?? row.seriesTitle ?? row.sourceTitle;
                const qualityName =
                  row.quality?.qualityId != null
                    ? qualityNames.get(row.quality.qualityId)
                    : undefined;
                const time = new Date(row.date).toLocaleTimeString();

                return (
                  <li
                    key={row.id}
                    className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="shrink-0 text-zinc-400"
                          title={row.mediaType === "movie" ? "Movie" : "Series"}
                          aria-label={row.mediaType === "movie" ? "Movie" : "Series"}
                        >
                          <MediaIcon mediaType={row.mediaType} />
                        </span>
                        <span className="min-w-0 truncate font-medium text-zinc-100">{title}</span>
                        <Badge tone={STAGE_TONE[row.data.stage]} className="capitalize">
                          {row.data.stage}
                        </Badge>
                        {qualityName && <Badge tone="neutral">{qualityName}</Badge>}
                      </div>

                      <p className="truncate font-mono text-xs text-zinc-500" title={row.sourceTitle}>
                        {row.sourceTitle}
                      </p>

                      {row.data.reason && (
                        <p className="text-sm text-red-300">{row.data.reason}</p>
                      )}

                      <p className="text-xs text-zinc-500">{time}</p>
                    </div>

                    <div className="shrink-0">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!reconstructed}
                        title={
                          reconstructed
                            ? undefined
                            : "Can't rebuild a search target for this failure"
                        }
                        onClick={() => reconstructed && setSearch(reconstructed)}
                      >
                        Search releases
                      </Button>
                    </div>
                  </li>
                );
              })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {search && (
        <ReleaseSearchDrawer
          scope={search.scope}
          title={search.title}
          qualityNames={qualityNames}
          onClose={() => {
            setSearch(null);
            void mutate();
          }}
        />
      )}
    </div>
  );
}
