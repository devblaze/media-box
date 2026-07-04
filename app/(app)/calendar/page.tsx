"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/api";
import { Calendar, dayKey, getCalendarDays } from "@/components/calendar";

/** One upcoming/aired episode from `GET /api/v1/calendar`. */
interface CalendarRow {
  episodeId: number;
  seriesId: number;
  seriesTitle: string;
  posterPath: string | null;
  isAnime: boolean;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airDateUtc: number | string;
  hasFile: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export default function CalendarPage() {
  const [month, setMonth] = useState(() => new Date());

  // The grid days are the single source of truth for the fetch window: fetch
  // from the first visible day (local midnight) to the end of the last visible
  // day, so every episode that lands in a rendered cell is included.
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

  // SWR key changes with the window, so navigating months re-fetches.
  const { data } = useApi<CalendarRow[]>(
    `/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  );

  // Group by local day of the air date so cells match the grid's local days.
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarRow[]>();
    for (const row of data ?? []) {
      const key = dayKey(new Date(row.airDateUtc));
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return map;
  }, [data]);

  return (
    <div className="px-4 py-6 md:px-12">
      <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Upcoming episodes from the series and anime you&apos;re monitoring.
      </p>

      <div className="mt-6">
        <Calendar
          month={month}
          onMonthChange={setMonth}
          renderDay={(day) => {
            const episodes = byDay.get(dayKey(day));
            if (!episodes?.length) return null;
            return (
              <div className="space-y-1">
                {episodes.map((ep) => (
                  <Link
                    key={ep.episodeId}
                    href={`/series/${ep.seriesId}`}
                    title={`${ep.seriesTitle} — S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}${
                      ep.episodeTitle ? ` · ${ep.episodeTitle}` : ""
                    }${ep.hasFile ? " (downloaded)" : ""}`}
                    className={cn(
                      "flex items-center gap-1 rounded border px-1.5 py-1 text-[11px] leading-tight transition-colors",
                      ep.isAnime
                        ? "border-violet-500/20 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25"
                        : "border-white/5 bg-white/5 text-zinc-200 hover:bg-white/10",
                      ep.hasFile && "opacity-50"
                    )}
                  >
                    <span className="min-w-0 truncate font-medium">{ep.seriesTitle}</span>
                    <span className="ml-auto shrink-0 font-mono opacity-70">
                      S{pad2(ep.seasonNumber)}E{pad2(ep.episodeNumber)}
                    </span>
                    {ep.hasFile && (
                      <span className="shrink-0 text-emerald-400" aria-label="Downloaded">
                        ✓
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}
