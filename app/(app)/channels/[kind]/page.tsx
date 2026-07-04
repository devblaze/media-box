"use client";

import { use } from "react";
import Link from "next/link";
import { type Channel, isChannel } from "@/lib/channels";
import { ChannelPlayer } from "@/components/channel-player";

export default function ChannelPage({ params }: PageProps<"/channels/[kind]">) {
  const { kind } = use(params);

  if (!isChannel(kind)) {
    return (
      <div className="p-6 text-sm text-zinc-400">
        Unknown channel.{" "}
        <Link className="text-amber-400 hover:underline" href="/channels">
          Back to channels
        </Link>
      </div>
    );
  }

  // Immersive: the player takes over the whole viewport (portaled), auto-plays,
  // and tries to enter fullscreen — no tune-in gate.
  return <ChannelPlayer kind={kind as Channel} />;
}
