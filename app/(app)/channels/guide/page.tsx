"use client";

import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { type Channel, CHANNEL_LABEL, CHANNELS } from "@/lib/channels";
import { Badge, EmptyState, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ChannelProgram } from "@/server/channels/schedule";

interface GuideResponse {
  channel: Channel;
  serverNow: number;
  programs: ChannelProgram[];
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export default function TvGuidePage() {
  const [tab, setTab] = useState<Channel>("series");
  const { data } = useApi<GuideResponse>(`/channels/${tab}/guide`, { refreshInterval: 60_000 });

  const programs = data?.programs ?? [];
  // Server-provided instant so "On now" highlighting is clock-skew-free (0 until loaded).
  const now = data?.serverNow ?? 0;

  // Group programs by day so a 12h lineup that crosses midnight stays readable.
  const groups: { day: string; items: ChannelProgram[] }[] = [];
  for (const p of programs) {
    const day = dayLabel(p.startAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(p);
    else groups.push({ day, items: [p] });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">TV Guide</h1>
        <Link
          href={`/channels/${tab}`}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-amber-500/60 hover:text-amber-300"
        >
          Watch {CHANNEL_LABEL[tab]}
        </Link>
      </div>

      <div className="mt-4 inline-flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
        {CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setTab(c)}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
              c === tab ? "bg-amber-500 text-zinc-950" : "text-zinc-300 hover:bg-white/5"
            )}
          >
            {CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>

      {!data ? (
        <div className="mt-5 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-md" />
          ))}
        </div>
      ) : programs.length === 0 ? (
        <EmptyState
          className="mt-5"
          title="Nothing scheduled"
          description={`The ${CHANNEL_LABEL[tab]} channel has no downloaded titles to broadcast yet.`}
        />
      ) : (
        <div className="mt-5 space-y-6">
          {groups.map((group) => (
            <div key={group.day}>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                {group.day}
              </div>
              <div className="overflow-hidden rounded-lg border border-zinc-800">
                {group.items.map((p, i) => {
                  const onNow = now >= p.startAt && now < p.endAt;
                  return (
                    <div
                      key={p.programId}
                      className={cn(
                        "flex items-center gap-4 px-4 py-3",
                        i > 0 && "border-t border-zinc-800",
                        onNow ? "bg-amber-500/10" : "bg-zinc-900/40"
                      )}
                    >
                      <div className="w-14 shrink-0 text-sm font-medium tabular-nums text-zinc-300">
                        {clockTime(p.startAt)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-zinc-100">
                            {p.seriesTitle ?? p.title}
                          </span>
                          {onNow && <Badge tone="accent">On now</Badge>}
                        </div>
                        <div className="truncate text-xs text-zinc-400">
                          {p.episodeLabel
                            ? [p.episodeLabel, p.subtitle].filter(Boolean).join(" · ")
                            : (p.subtitle ?? "")}
                        </div>
                      </div>
                      <div className="shrink-0 text-xs text-zinc-500">
                        {Math.round(p.durationSeconds / 60)}m
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
