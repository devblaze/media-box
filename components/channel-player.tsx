"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Callout, Spinner } from "@/components/ui";
import { type Channel, CHANNEL_LABEL } from "@/lib/channels";
import type { ChannelNow, ChannelProgram } from "@/server/channels/schedule";
import type { MediaInfo } from "@/server/library/media-info";

// hls.js is loaded dynamically (client-only, code-split) exactly as media-player does.
type HlsInstance = InstanceType<(typeof import("hls.js"))["default"]>;

// Same native-playback baseline as the on-demand player (media-player.tsx).
const DIRECT_CONTAINERS = new Set(["mp4", "m4v", "mov"]);
const DIRECT_VIDEO = new Set(["h264", "avc", "avc1"]);
const DIRECT_AUDIO = new Set(["aac"]);

function canDirectPlay(info: MediaInfo | null): boolean {
  if (!info) return true;
  const container = info.container.toLowerCase();
  const vcodec = info.video?.codec.toLowerCase() ?? "";
  const acodec = info.audio?.codec.toLowerCase() ?? "";
  return DIRECT_CONTAINERS.has(container) && DIRECT_VIDEO.has(vcodec) && DIRECT_AUDIO.has(acodec);
}

function programSubline(p: ChannelProgram): string {
  if (p.episodeLabel) {
    return [p.seriesTitle, p.episodeLabel, p.subtitle].filter(Boolean).join(" · ");
  }
  return p.subtitle ?? p.title;
}

/**
 * Full-bleed "live TV" player for one channel. Fetches the current program and
 * its live seek offset, plays it, and auto-advances to the next program when the
 * slot ends (on the video's `ended` event, or a wall-clock backstop timer). It
 * deliberately reuses only the stream/transcode transport — no scrubbing, no
 * per-user watch-progress — because the schedule, not the viewer, drives playback.
 */
export function ChannelPlayer({ kind }: { kind: Channel }) {
  const [muted, setMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  // Fetch via SWR (like the rest of the app). Advancing = a revalidation: when
  // the current slot ends we `mutate()` to pull the next program. The video is
  // keyed by programId, so an unchanged program keeps playing and a new one
  // remounts at its live offset.
  const { data, error, mutate } = useApi<ChannelNow>(`/channels/${kind}`);
  const advance = useCallback(() => void mutate(), [mutate]);

  const current = data?.current ?? null;

  // Backstop: advance when the current slot is scheduled to end, even if the
  // video's `ended` never fires (e.g. the file outran its scheduled duration).
  useEffect(() => {
    if (!current) return;
    const remainingMs = current.endAt - Date.now();
    const t = window.setTimeout(advance, Math.max(1000, remainingMs + 750));
    return () => window.clearTimeout(t);
  }, [current, advance]);

  // Empty-channel poll: nothing scheduled yet — re-check periodically.
  useEffect(() => {
    if (current || error) return;
    const t = window.setTimeout(advance, 15_000);
    return () => window.clearTimeout(t);
  }, [current, error, advance]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 3500);
  }, []);

  // Start the auto-hide timer on mount (controls begin visible). Not showControls()
  // — a direct setState in an effect is disallowed; the timeout callback is fine.
  useEffect(() => {
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 3500);
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    } else {
      void el?.requestFullscreen?.().catch(() => {});
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative flex h-full w-full items-center justify-center bg-black", !controlsVisible && "cursor-none")}
      onMouseMove={showControls}
    >
      {current ? (
        <LiveVideo
          key={current.programId}
          program={current}
          offsetSeconds={current.offsetSeconds}
          muted={muted}
          onAdvance={advance}
        />
      ) : error ? (
        <div className="p-6">
          <Callout tone="danger" title="Channel unavailable" className="max-w-md bg-zinc-900/90">
            {error instanceof Error ? error.message : "Failed to load channel."}
          </Callout>
        </div>
      ) : data ? (
        <div className="max-w-md p-6 text-center text-zinc-300">
          <p className="text-lg font-semibold text-white">Nothing on this channel yet</p>
          <p className="mt-2 text-sm text-zinc-400">
            Add some {kind} with downloaded files and the {CHANNEL_LABEL[kind]} channel will start
            broadcasting.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-zinc-400">
          <Spinner className="size-6" />
          <span className="text-sm">Tuning in…</span>
        </div>
      )}

      {/* Top bar: back, channel name, LIVE, channel switcher */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 py-3 pb-10 transition-opacity duration-300",
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <Link
          href="/channels"
          aria-label="Back to channels"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 font-semibold text-white transition-colors hover:bg-white/10"
        >
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        <span className="inline-flex items-center gap-2 text-base font-semibold text-white">
          <span className="inline-flex items-center gap-1.5 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
            <span className="size-1.5 rounded-full bg-white" />
            Live
          </span>
          {CHANNEL_LABEL[kind]}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
            <Link
              key={c}
              href={`/channels/${c}`}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                c === kind ? "bg-amber-500 text-zinc-950" : "text-zinc-200 hover:bg-white/10"
              )}
            >
              {CHANNEL_LABEL[c]}
            </Link>
          ))}
        </div>
      </div>

      {/* Bottom bar: now playing, up next, mute, fullscreen */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-4 py-4 transition-opacity duration-300",
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <div className="min-w-0">
          {current && (
            <>
              <div className="truncate text-lg font-semibold text-white">
                {current.seriesTitle ?? current.title}
              </div>
              <div className="truncate text-sm text-zinc-300">{programSubline(current)}</div>
            </>
          )}
          {data?.upNext?.[0] && (
            <div className="mt-1 truncate text-xs text-zinc-400">
              Up next: {data.upNext[0].seriesTitle ?? data.upNext[0].title}
              {data.upNext[0].episodeLabel ? ` · ${data.upNext[0].episodeLabel}` : ""}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setMuted((m) => !m);
              showControls();
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            className="rounded-md p-2 text-zinc-200 transition-colors hover:bg-white/10"
          >
            {muted ? (
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                <path d="m23 9-6 6M17 9l6 6" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              toggleFullscreen();
              showControls();
            }}
            aria-label="Fullscreen"
            className="rounded-md p-2 text-zinc-200 transition-colors hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Plays one program, seeking to the live offset. Starts in direct or transcode
 * mode based on {@link MediaInfo}; a failed direct play falls back to transcode,
 * and a fatal transcode error advances the channel so it never gets stuck.
 */
function LiveVideo({
  program,
  offsetSeconds,
  muted,
  onAdvance,
}: {
  program: ChannelProgram;
  offsetSeconds: number;
  muted: boolean;
  onAdvance: () => void;
}) {
  const [mode, setMode] = useState<"direct" | "transcode">(() =>
    canDirectPlay(program.mediaInfo) ? "direct" : "transcode"
  );

  return mode === "direct" ? (
    <DirectLive
      target={program.target}
      offsetSeconds={offsetSeconds}
      muted={muted}
      onEnded={onAdvance}
      onFallback={() => setMode("transcode")}
    />
  ) : (
    <TranscodeLive
      target={program.target}
      offsetSeconds={offsetSeconds}
      muted={muted}
      onEnded={onAdvance}
    />
  );
}

function DirectLive({
  target,
  offsetSeconds,
  muted,
  onEnded,
  onFallback,
}: {
  target: { type: "movie" | "episode"; id: number };
  offsetSeconds: number;
  muted: boolean;
  onEnded: () => void;
  onFallback: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const src = `/api/v1/stream/${target.type}/${target.id}`;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const seek = () => {
      if (offsetSeconds > 1 && Number.isFinite(v.duration)) {
        try {
          v.currentTime = Math.min(offsetSeconds, Math.max(0, v.duration - 1));
        } catch {
          /* not seekable yet — start from the top */
        }
      }
    };
    v.addEventListener("loadedmetadata", seek);
    if (v.readyState >= 1) seek();
    void v.play?.().catch(() => {});
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [offsetSeconds]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className="h-full w-full bg-black object-contain"
      src={src}
      onEnded={onEnded}
      onError={onFallback}
    />
  );
}

function TranscodeLive({
  target,
  offsetSeconds,
  muted,
  onEnded,
}: {
  target: { type: "movie" | "episode"; id: number };
  offsetSeconds: number;
  muted: boolean;
  onEnded: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "playing" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let hls: HlsInstance | null = null;
    let sessionId: string | null = null;

    async function start() {
      try {
        const res = await apiFetch<{ sessionId: string; url: string }>("/transcode", {
          method: "POST",
          body: JSON.stringify({
            type: target.type,
            id: target.id,
            startSec: Math.max(0, Math.floor(offsetSeconds)),
          }),
        });
        sessionId = res.sessionId;
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;

        const { default: Hls } = await import("hls.js");
        if (cancelled) return;

        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true });
          hls.on(Hls.Events.ERROR, (_evt, d) => {
            if (d.fatal && !cancelled) {
              setStatus("error");
              setError("The transcode stream failed.");
            }
          });
          hls.loadSource(res.url);
          hls.attachMedia(video);
          setStatus("playing");
          void video.play?.().catch(() => {});
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = res.url;
          setStatus("playing");
          void video.play?.().catch(() => {});
        } else {
          setStatus("error");
          setError("Your browser cannot play HLS streams.");
        }
      } catch (err) {
        if (cancelled) return;
        const httpStatus = err instanceof ApiError ? err.status : 0;
        setStatus("error");
        setError(
          httpStatus === 503
            ? "Transcoding is unavailable — ffmpeg is not installed on the server."
            : httpStatus === 429
              ? "The server is at its transcoding capacity."
              : err instanceof Error
                ? err.message
                : "Failed to start transcoding."
        );
      }
    }

    void start();
    return () => {
      cancelled = true;
      hls?.destroy();
      if (sessionId) {
        void fetch(`/api/v1/transcode/${sessionId}`, { method: "DELETE", keepalive: true }).catch(
          () => {}
        );
      }
    };
  }, [target.type, target.id, offsetSeconds]);

  // A fatal transcode error auto-advances after a beat so the channel never stalls.
  useEffect(() => {
    if (status !== "error") return;
    const t = window.setTimeout(onEnded, 4000);
    return () => window.clearTimeout(t);
  }, [status, onEnded]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className="h-full w-full bg-black object-contain"
        onEnded={onEnded}
      />
      {status === "starting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-zinc-300">
          <Spinner className="size-6" />
          <span>Starting transcode…</span>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <Callout tone="warning" title="Playback error" className="max-w-md bg-zinc-900/90">
            {error} Skipping to the next program…
          </Callout>
        </div>
      )}
    </>
  );
}
