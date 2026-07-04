"use client";

import { use, useEffect, useState } from "react";
import { VideoPlayerModal } from "@/components/media-player";
import { Spinner } from "@/components/ui";

/** Read the cast token + optional title from the URL (client-only). */
function readQuery(): { key: string; title: string } {
  if (typeof window === "undefined") return { key: "", title: "" };
  const q = new URLSearchParams(window.location.search);
  return { key: q.get("key") ?? "", title: q.get("title") ?? "" };
}

const VALID_TYPES = new Set(["movie", "episode"]);

/**
 * "Play on TV" target — a chrome-free full-screen page for a single movie/episode
 * on a TV browser or a Fully Kiosk tablet. It exchanges the URL's ?key= token for
 * a session, then reuses the full on-demand player (quality/subtitles/transcode)
 * over the resulting cookie. Lives outside the (app) shell, so no header/nav.
 */
export default function KioskWatchPage({ params }: PageProps<"/tv/watch/[type]/[id]">) {
  const { type, id } = use(params);
  const numericId = Number(id);
  const valid = VALID_TYPES.has(type) && Number.isInteger(numericId) && numericId > 0;
  const [q] = useState(readQuery);
  const [state, setState] = useState<"authing" | "ready" | "error">("authing");

  useEffect(() => {
    if (!valid) return;
    let active = true;
    fetch("/api/v1/auth/kiosk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: q.key }),
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
  }, [valid, q.key]);

  if (!valid || state === "error") {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center">
        <p className="text-lg font-semibold text-white">Can’t play this title</p>
        <p className="max-w-sm text-sm text-zinc-400">
          This cast link is invalid or has expired. Open a fresh link from the title’s page.
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

  return (
    <VideoPlayerModal
      target={{ type: type as "movie" | "episode", id: numericId }}
      title={q.title || "Now Playing"}
      onClose={() => {
        if (typeof window !== "undefined") window.history.back();
      }}
    />
  );
}
