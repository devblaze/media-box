"use client";

import { use, useEffect, useState } from "react";
import { type Channel, isChannel } from "@/lib/channels";
import { ChannelPlayer } from "@/components/channel-player";
import { Spinner } from "@/components/ui";

/** Read the cast token from the URL (client-only; "" during SSR). */
function readKey(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("key") ?? "";
}

/**
 * Kiosk / cast surface: a chrome-free, full-screen channel for a TV browser or a
 * Fully Kiosk tablet. It exchanges the URL's ?key= token for a session (so the
 * device never logs in), then plays the channel. Outside the (app) shell, so no
 * header/nav — just the stream.
 */
export default function KioskChannelPage({ params }: PageProps<"/tv/[kind]">) {
  const { kind } = use(params);
  const valid = isChannel(kind);
  const [key] = useState(readKey);
  const [state, setState] = useState<"authing" | "ready" | "error">("authing");

  useEffect(() => {
    if (!valid) return;
    let active = true;
    fetch("/api/v1/auth/kiosk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    })
      .then((r) => {
        if (active) setState(r.ok ? "ready" : "error");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [valid, key]);

  if (!valid || state === "error") {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center">
        <p className="text-lg font-semibold text-white">Channel unavailable</p>
        <p className="max-w-sm text-sm text-zinc-400">
          This cast link is invalid or has expired. Ask an admin for a fresh link from the Channels
          page.
        </p>
      </div>
    );
  }

  if (state === "authing") {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black text-zinc-400">
        <Spinner className="size-6" />
      </div>
    );
  }

  return <ChannelPlayer kind={kind as Channel} kiosk basePath="/tv" accessKey={key} />;
}
