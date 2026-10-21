"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Spinner, useToast } from "@/components/ui";
import { VideoPlayerModal, type PlaybackTarget } from "@/components/media-player";

/** A library title a card can start playing without visiting its page first. */
export type PlayableTitle = { mediaType: "movie" | "series"; mediaId: number; title: string };

/** The parts of `GET /series/{id}/resume` that decide what Play opens. */
type SeriesResume = {
  episode: { id: number; seasonNumber: number; episodeNumber: number; title: string | null } | null;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Play a title straight from a card. A movie opens at once; a series asks the
 * server which episode is next for this viewer — the one they're part-way
 * through, else the next unwatched one, else the first that's downloaded — and
 * opens that. Render `player` somewhere in the card: it's the modal while
 * something is playing, and nothing otherwise.
 */
export function useInstantPlay() {
  const toast = useToast();
  const [session, setSession] = useState<{ target: PlaybackTarget; title: string } | null>(null);
  const [starting, setStarting] = useState(false);

  const play = useCallback(
    async ({ mediaType, mediaId, title }: PlayableTitle) => {
      if (mediaType === "movie") {
        setSession({ target: { type: "movie", id: mediaId }, title });
        return;
      }
      setStarting(true);
      try {
        const { episode: ep } = await apiFetch<SeriesResume>(`/series/${mediaId}/resume`);
        if (!ep) {
          toast.info("No episodes of this series are downloaded yet");
          return;
        }
        setSession({
          target: { type: "episode", id: ep.id },
          title: `${title} · S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}${ep.title ? ` · ${ep.title}` : ""}`,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't start playback");
      } finally {
        setStarting(false);
      }
    },
    [toast]
  );

  const player = session ? (
    <VideoPlayerModal
      target={session.target}
      title={session.title}
      onClose={() => setSession(null)}
    />
  ) : null;

  return { play, starting, player };
}

/**
 * The round white ▶ that starts playback. Sits above a card's details link
 * (never inside it), so a click here plays and a click anywhere else on the card
 * opens the details page.
 */
export function PlayButton({
  title,
  onClick,
  busy = false,
  size = "md",
  className,
}: {
  /** What plays, for the accessible label. */
  title: string;
  onClick: () => void;
  busy?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={busy}
      aria-label={`Play ${title}`}
      title="Play now"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-white text-black shadow-lg shadow-black/40 transition-transform duration-200 hover:scale-110 focus-visible:ring-4 focus-visible:ring-white/40 focus-visible:outline-none active:scale-95 disabled:cursor-wait",
        size === "sm" && "size-9",
        size === "md" && "size-11",
        size === "lg" && "size-14",
        className
      )}
    >
      {busy ? (
        <Spinner className="size-1/2" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          className="ml-[8%] size-1/2"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M7 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" />
        </svg>
      )}
    </button>
  );
}
