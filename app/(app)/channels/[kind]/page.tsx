"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { type Channel, CHANNEL_LABEL, CHANNELS, isChannel } from "@/lib/channels";
import { ChannelPlayer } from "@/components/channel-player";
import { Button } from "@/components/ui";
import type { ChannelNow } from "@/server/channels/schedule";

export default function ChannelPage({ params }: PageProps<"/channels/[kind]">) {
  const { kind } = use(params);
  const valid = isChannel(kind);
  const [tuned, setTuned] = useState(false);
  // Fetch a preview only while the tune-in gate is showing (autoplay needs a click).
  const { data } = useApi<ChannelNow>(valid && !tuned ? `/channels/${kind}` : null);

  if (!valid) {
    return (
      <div className="p-6 text-sm text-zinc-400">
        Unknown channel.{" "}
        <Link className="text-amber-400 hover:underline" href="/channels">
          Back to channels
        </Link>
      </div>
    );
  }
  const channel = kind as Channel;
  const current = data?.current ?? null;
  const backdrop = current?.backdropPath
    ? `https://image.tmdb.org/t/p/w1280${current.backdropPath}`
    : null;

  if (tuned) {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-zinc-800 bg-black">
        <ChannelPlayer kind={channel} />
      </div>
    );
  }

  return (
    <div className="relative flex aspect-video w-full flex-col items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-center">
      {backdrop && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/40" />
      <div className="relative z-10 flex flex-col items-center gap-4 px-6">
        <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-amber-400">
          <span className="size-1.5 rounded-full bg-red-500" />
          Live · {CHANNEL_LABEL[channel]}
        </span>
        <div className="min-h-[3rem]">
          {current ? (
            <>
              <div className="text-2xl font-bold text-white">
                {current.seriesTitle ?? current.title}
              </div>
              <div className="mt-1 text-sm text-zinc-300">
                {current.episodeLabel
                  ? [current.episodeLabel, current.subtitle].filter(Boolean).join(" · ")
                  : (current.subtitle ?? "")}
              </div>
            </>
          ) : data ? (
            <div className="text-lg text-zinc-300">Nothing on this channel yet</div>
          ) : (
            <div className="text-lg text-zinc-500">Loading…</div>
          )}
        </div>
        <Button size="lg" onClick={() => setTuned(true)} disabled={!current}>
          ▶ Tune in
        </Button>
        <div className="mt-2 flex items-center gap-1">
          {CHANNELS.map((c) => (
            <Link
              key={c}
              href={`/channels/${c}`}
              className={
                c === channel
                  ? "rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950"
                  : "rounded-md px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-white/10"
              }
            >
              {CHANNEL_LABEL[c]}
            </Link>
          ))}
          <Link
            href="/channels/guide"
            className="rounded-md px-3 py-1 text-xs font-medium text-zinc-400 hover:bg-white/10"
          >
            TV Guide
          </Link>
        </div>
      </div>
    </div>
  );
}
