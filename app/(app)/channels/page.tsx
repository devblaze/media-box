"use client";

import Link from "next/link";
import { apiFetch, useApi } from "@/lib/api";
import { type Channel, CHANNEL_LABEL, CHANNELS } from "@/lib/channels";
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import type { ChannelProgram } from "@/server/channels/schedule";

interface ChannelSummary {
  channel: Channel;
  serverNow: number;
  current: ChannelProgram | null;
  next: ChannelProgram | null;
}

interface Me {
  role: "admin" | "user";
}

const CHANNEL_BLURB: Record<Channel, string> = {
  movies: "Franchises in order, then a random reel.",
  series: "Every show, next episode in order.",
  anime: "Japanese animation, always in sequence.",
};

function nowLine(p: ChannelProgram | null): string {
  if (!p) return "Off air";
  if (p.episodeLabel) return [p.seriesTitle, p.episodeLabel].filter(Boolean).join(" · ");
  return p.title;
}

export default function ChannelsPage() {
  const { data } = useApi<{ channels: ChannelSummary[] }>("/channels", {
    refreshInterval: 30_000,
  });
  const { data: me } = useApi<Me>("/auth/me");

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Channels</h1>
        <Link
          href="/channels/guide"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-amber-500/60 hover:text-amber-300"
        >
          TV Guide
        </Link>
      </div>
      <p className="mt-1 text-sm text-zinc-400">
        Lean-back live channels — always on, always in order. Tune in and let it play.
      </p>

      {!data ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.channels.map(({ channel, current, next }) => {
            const backdrop = current?.backdropPath
              ? `https://image.tmdb.org/t/p/w780${current.backdropPath}`
              : null;
            return (
              <Link
                key={channel}
                href={`/channels/${channel}`}
                className="group relative flex aspect-video flex-col justify-end overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-amber-500/60"
              >
                {backdrop && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={backdrop}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover opacity-40 transition-opacity group-hover:opacity-55"
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
                <div className="relative z-10">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                      <span className="size-1.5 rounded-full bg-white" />
                      Live
                    </span>
                    <span className="text-lg font-bold text-white">{CHANNEL_LABEL[channel]}</span>
                  </div>
                  <div className="mt-2 truncate text-sm font-medium text-zinc-100">
                    {nowLine(current)}
                  </div>
                  <div className="truncate text-xs text-zinc-400">
                    {current ? CHANNEL_BLURB[channel] : "Add some titles to start broadcasting."}
                  </div>
                  {next && (
                    <div className="mt-1 truncate text-xs text-zinc-500">
                      Up next: {next.seriesTitle ?? next.title}
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {me?.role === "admin" && <CastLinksPanel />}
    </div>
  );
}

/**
 * Admin-only: the tokenized /tv URLs to open on a TV browser or a Fully Kiosk
 * tablet. Each plays that channel full-screen with no login. Regenerating the
 * token invalidates every previously shared link.
 */
function CastLinksPanel() {
  const { data, mutate } = useApi<{ token: string }>("/kiosk");
  const token = data?.token;

  async function regenerate() {
    await apiFetch("/kiosk", { method: "POST" }).catch(() => {});
    void mutate();
  }

  function selectAll(e: React.FocusEvent<HTMLInputElement>) {
    e.target.select();
  }

  return (
    <Card className="mt-8">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Cast to a TV / kiosk</CardTitle>
        {token && (
          <Button size="sm" variant="ghost" onClick={regenerate}>
            Regenerate links
          </Button>
        )}
      </CardHeader>
      <CardBody>
        <p className="text-sm text-zinc-400">
          Open one of these URLs on a smart-TV browser or a tablet in Fully Kiosk mode — it plays
          that channel full-screen, no login. Anyone with a link can watch, so keep them private;
          regenerate to revoke old links. For sound on autoplay, enable video/audio autoplay in the
          kiosk browser.
        </p>
        {!token ? (
          <Skeleton className="mt-4 h-10 w-full" />
        ) : (
          <div className="mt-4 space-y-3">
            {CHANNELS.map((c) => {
              const href = `/tv/${c}?key=${token}`;
              return (
                <div key={c} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-sm font-medium text-zinc-200">
                    {CHANNEL_LABEL[c]}
                  </span>
                  <input
                    readOnly
                    value={href}
                    onFocus={selectAll}
                    className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-300"
                  />
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-amber-500/60 hover:text-amber-300"
                  >
                    Open ↗
                  </a>
                </div>
              );
            })}
            <p className="text-xs text-zinc-500">
              Paths are relative to this server (e.g. prepend <code>http://your-box:7878</code> when
              typing on another device). Click a field to select it.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
