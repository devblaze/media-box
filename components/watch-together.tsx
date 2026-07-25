"use client";

import { useCallback, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui";
import { VideoPlayerModal, type PlaybackTarget } from "@/components/media-player";

/** A joinable host from `GET /watch-together/hosts`. */
interface Host {
  userId: number;
  username: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
  kind: "movie" | "episode";
  target: { type: "movie" | "episode"; id: number };
}

/** The `POST /watch-together/join` response. */
interface JoinResponse {
  hostUserId: number;
  hostUsername: string;
  target: PlaybackTarget;
  title: string;
  positionSeconds: number;
}

/** The active joiner session (the title we opened watching along with a host). */
interface JoinerSession {
  hostUserId: number;
  hostUsername: string;
  target: PlaybackTarget;
  title: string;
  startPositionSeconds: number;
}

function PeopleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/**
 * "Watch together" entry point for the browse header: a button that opens a panel
 * listing users currently sharing a stream, each joinable. Joining opens the
 * player in sync (role="joiner"); a top pill shows who you're watching with and a
 * Leave action. Mounted once in the header so the joiner session survives page
 * navigation within the browse shell.
 */
export function WatchTogetherButton() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [joining, setJoining] = useState<number | null>(null);
  const [session, setSession] = useState<JoinerSession | null>(null);

  // Always keep the hosts list warm so the badge shows a live count. A
  // `watch.streamsChanged` SSE event revalidates it the moment a sharing user
  // starts streaming; the slow background poll only covers streams EXPIRING
  // (the 90s heartbeat window lapsing emits nothing). Faster while open.
  const { data: hosts, isLoading } = useApi<Host[]>("/watch-together/hosts", {
    refreshInterval: open ? 10_000 : 60_000,
  });
  const hostCount = hosts?.length ?? 0;

  const join = useCallback(
    async (host: Host) => {
      setJoining(host.userId);
      try {
        const res = await apiFetch<JoinResponse>("/watch-together/join", {
          method: "POST",
          body: JSON.stringify({ hostUserId: host.userId }),
        });
        setSession({
          hostUserId: res.hostUserId,
          hostUsername: res.hostUsername,
          target: res.target,
          title: res.title,
          startPositionSeconds: res.positionSeconds,
        });
        setOpen(false);
        toast.success(`Watching with ${res.hostUsername}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't join that stream");
      } finally {
        setJoining(null);
      }
    },
    [toast]
  );

  const leave = useCallback(async () => {
    setSession(null);
    try {
      await apiFetch("/watch-together/leave", { method: "POST" });
    } catch {
      /* best-effort — the local session is already closed */
    }
  }, []);

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Watch together (${hostCount} streaming)`}
          aria-expanded={open}
          title="Watch together — join someone's stream"
          className="relative inline-flex size-9 items-center justify-center rounded-md text-zinc-200 transition-colors hover:bg-white/10"
        >
          <PeopleIcon />
          {/* Live count of joinable streams; accent when someone's on. */}
          <span
            className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ${
              hostCount > 0 ? "bg-emerald-500 text-black" : "bg-zinc-700 text-zinc-300"
            }`}
          >
            {hostCount}
          </span>
        </button>
        {open && (
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div className="absolute right-0 z-50 mt-2 w-72 rounded border border-white/10 bg-black/95 py-2 text-sm shadow-xl backdrop-blur">
              <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Watch together
              </div>
              <div className="my-1 border-t border-white/10" />
              {isLoading && !hosts && <p className="px-3 py-2 text-zinc-500">Looking for hosts…</p>}
              {hosts && hosts.length === 0 && (
                <p className="px-3 py-2 text-zinc-500">No one is sharing a stream right now.</p>
              )}
              {hosts?.map((h) => (
                <div key={h.userId} className="flex items-center gap-2 px-3 py-2">
                  {h.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={h.poster} alt="" className="h-12 w-8 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="h-12 w-8 shrink-0 rounded bg-zinc-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-zinc-100">{h.username}</div>
                    <div className="truncate text-xs text-zinc-400">{h.title}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void join(h)}
                    disabled={joining === h.userId}
                    className="shrink-0 rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-60"
                  >
                    {joining === h.userId ? "Joining…" : "Join"}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {session && (
        <>
          <VideoPlayerModal
            target={session.target}
            title={session.title}
            sync={{
              role: "joiner",
              hostUserId: session.hostUserId,
              startPositionSeconds: session.startPositionSeconds,
            }}
            onClose={() => void leave()}
          />
          {/* "Watching with <host>" pill — above the player overlay (z-[60]). */}
          <div className="fixed left-1/2 top-4 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-black/80 px-4 py-1.5 text-sm text-white shadow-lg backdrop-blur">
            <span className="inline-flex items-center gap-1.5">
              <PeopleIcon className="size-4 text-red-500" />
              Watching with <span className="font-semibold">{session.hostUsername}</span>
            </span>
            <button
              type="button"
              onClick={() => void leave()}
              className="rounded-full border border-white/25 px-2.5 py-0.5 text-xs font-medium transition-colors hover:bg-white/10"
            >
              Leave
            </button>
          </div>
        </>
      )}
    </>
  );
}
