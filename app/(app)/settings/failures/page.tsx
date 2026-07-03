"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import { Calendar, dayKey, getCalendarDays, isSameDay } from "@/components/calendar";
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

  const selectedFailures = byDay.get(dayKey(selectedDay)) ?? [];
  const loading = failures === undefined;
  const dayLabel = selectedDay.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold">Failed downloads</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Grab, download, and import failures — click a day to inspect and re-search.
      </p>

      <div className="mt-6">
        <Calendar
          month={month}
          onMonthChange={setMonth}
          selectedDay={selectedDay}
          onDayClick={setSelectedDay}
          renderDay={(day) => {
            const count = byDay.get(dayKey(day))?.length;
            if (!count) return null;
            return (
              <Badge tone="danger" className="w-full justify-center">
                {count} failed
              </Badge>
            );
          }}
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{dayLabel}</CardTitle>
          {selectedFailures.length > 0 && (
            <Badge tone="danger">
              {selectedFailures.length} {selectedFailures.length === 1 ? "failure" : "failures"}
            </Badge>
          )}
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : selectedFailures.length === 0 ? (
            <EmptyState
              title="No failures on this day"
              description="Pick a day with a red badge to see what went wrong and re-search for a replacement."
            />
          ) : (
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
