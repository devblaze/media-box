"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { resumeStartSeconds } from "@/lib/resume";
import type { SubtitleStyle } from "@/lib/subtitle-style";
import { DEFAULT_TRANSCODE_QUALITY, type TranscodeQuality } from "@/lib/transcode-quality";
import { Callout, Spinner } from "@/components/ui";
import {
  SubtitleOverlay,
  SubtitleTracks,
  useStyledSubtitles,
  type SubtitleTrack,
} from "@/components/subtitle-overlay";
import { transcodeHlsConfig } from "./hls-config";
import { useRegisterVideo } from "./media-hooks";
import { useWatchProgress } from "./use-watch-progress";
import type { PlaybackTarget, TimeReport, WatchProgress } from "./types";

type HlsInstance = InstanceType<(typeof import("hls.js"))["default"]>;

/** How often the transcode reports its measured throughput back to the player. */
const LINK_REPORT_INTERVAL_MS = 5_000;
/** A fragment smaller than this is too small a sample to divide by. */
const LINK_SAMPLE_MIN_BYTES = 64 * 1024;
/**
 * Floor on the time a sample is divided by. A small segment down a fast link can
 * land inside the clock's noise; clamping turns that into a LOWER BOUND on the
 * speed rather than a discarded sample, so a connection that recovers while a
 * low rung is playing still produces the readings that let auto climb back.
 */
const LINK_SAMPLE_FLOOR_MS = 80;
/** Buffer stalls within this window count towards the same slow-link verdict. */
const STALL_WINDOW_MS = 60_000;
/** Stalls in that window before the transcode drops to a smaller rung. */
const STALLS_BEFORE_STEP_DOWN = 3;
/**
 * Stalls this soon after a seek aren't counted against the link. A seek into time
 * the encoder hasn't reached waits for ffmpeg to restart there, which says nothing
 * about the connection, and a few quick skips used to add up to a rung drop.
 */
const SEEK_STALL_GRACE_MS = 15_000;
/**
 * How long a transcode's playhead may sit still, when it should be playing, before
 * the player re-requests what it is waiting for. A load lost across a quick run of
 * seeks otherwise leaves hls.js on its retry schedule, with the picture frozen.
 */
const STUCK_RELOAD_MS = 10_000;
/** Fatal hls.js errors in a row (no fragment landing between) before giving up. */
const MAX_CONSECUTIVE_FATAL = 6;

type StartResponse = { sessionId: string; url: string; seekable?: boolean; durationSec?: number };

/**
 * Server-side HLS playback. On mount it POSTs to start a transcode session, then
 * attaches hls.js (or native HLS on Safari) to the `<video>`. On unmount it
 * destroys the hls.js instance and DELETEs the session so the server tears down
 * ffmpeg and reclaims disk.
 */
export function TranscodePlayer({
  target,
  fileId,
  tracks,
  selectedSub,
  subtitleStyle,
  subtitleOffset,
  onTime,
  onEnded,
  audioTrack,
  onVideoEl,
  disableProgress,
  initialStartSec,
  quality,
  onTooSlow,
  onLinkKbps,
  slowHint,
}: {
  target: PlaybackTarget;
  fileId: number | null;
  tracks: SubtitleTrack[];
  selectedSub: number;
  subtitleStyle: SubtitleStyle;
  subtitleOffset: number;
  onTime?: TimeReport;
  onEnded?: () => void;
  audioTrack?: number | null;
  onVideoEl?: (el: HTMLVideoElement | null) => void;
  disableProgress?: boolean;
  /** Media-time to start the transcode at — a watch-together joiner's host position,
   *  or where playback had got to when the stream was re-created (a quality change,
   *  a hand-over from direct play). Undefined = resume from saved progress. */
  initialStartSec?: number;
  /** Bitrate rung the session is pinned to. Changing it remounts this player. */
  quality: TranscodeQuality;
  /** Ask for the next rung down. False when there is none left to drop to. */
  onTooSlow: () => boolean;
  /** Throughput measured off the segments this session is delivering, kbps. */
  onLinkKbps: (kbps: number) => void;
  /** What to tell the viewer when `onTooSlow` had nothing left to give up. */
  slowHint: string;
}) {
  const { type, id } = target;
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleSinkRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"starting" | "playing" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  // Set when the stream keeps stalling and there is no lower rung left to try.
  const [linkTooSlow, setLinkTooSlow] = useState(false);
  // Held in a ref so the start effect doesn't restart the whole session just
  // because the parent re-rendered with a new callback identity.
  const tooSlowRef = useRef(onTooSlow);
  const linkKbpsRef = useRef(onLinkKbps);
  useEffect(() => {
    tooSlowRef.current = onTooSlow;
    linkKbpsRef.current = onLinkKbps;
  }, [onTooSlow, onLinkKbps]);
  // Media-time of the stream's 0:00. null until known. A seekable session's
  // timeline is the film's own (0); only the legacy event playlist, used when the
  // runtime can't be probed, starts at `startSec` and can't seek to unencoded time.
  const [baseOffset, setBaseOffset] = useState<number | null>(
    initialStartSec != null ? Math.max(0, Math.floor(initialStartSec)) : disableProgress ? 0 : null
  );
  const [knownDuration, setKnownDuration] = useState(0);

  // No resume seek here: the player resolves the start itself, before the session
  // exists, and hands it to hls.js as `startPosition`.
  useWatchProgress(videoRef, target, {
    disabled: disableProgress,
    offsetSeconds: baseOffset,
    knownDurationSeconds: knownDuration,
    resume: false,
  });
  useStyledSubtitles(videoRef, tracks, selectedSub, subtitleOffset, subtitleSinkRef);
  useRegisterVideo(videoRef, onVideoEl);

  useEffect(() => {
    let cancelled = false;
    let hls: HlsInstance | null = null;
    let sessionId: string | null = null;
    const el = videoRef.current;
    if (!el) return;
    const video: HTMLVideoElement = el; // narrowed for the hoisted helpers below

    // When the viewer last seeked: stalls right after one are the encoder catching
    // up to the new spot, not the link (see SEEK_STALL_GRACE_MS).
    let lastSeekAt = 0;
    const onSeeking = () => {
      lastSeekAt = Date.now();
    };
    video.addEventListener("seeking", onSeeking);

    // Watchdog: a playhead that should be moving and hasn't for STUCK_RELOAD_MS is
    // waiting on a load that isn't coming. With data buffered ahead it's a stuck
    // decoder or a gap at a seam between ffmpeg runs, which a small nudge clears;
    // with none, re-request from where the playhead is.
    let lastPos = -1;
    let stuckSince = Date.now();
    const watchdog = window.setInterval(() => {
      const now = Date.now();
      if (video.paused || video.ended || video.currentTime !== lastPos) {
        lastPos = video.currentTime;
        stuckSince = now;
        return;
      }
      if (now - stuckSince < STUCK_RELOAD_MS) return;
      stuckSince = now;
      const t = video.currentTime;
      if (bufferedAhead(video, t) > 0.5) {
        video.currentTime = t + 0.1;
      } else if (hls) {
        hls.stopLoad();
        hls.startLoad(t);
      } else {
        // Native HLS (Safari): seeking to where it already is makes it re-request.
        video.currentTime = t;
      }
    }, 1_000);

    /** Where to start: the caller's position, else this user's saved progress. */
    async function resolveStart(): Promise<number> {
      if (initialStartSec != null) return Math.max(0, Math.floor(initialStartSec));
      if (disableProgress) return 0;
      const key = type === "movie" ? "movieId" : "episodeId";
      try {
        const p = await apiFetch<WatchProgress | null>(`/watch-progress?${key}=${id}`);
        if (!cancelled && p && p.durationSeconds > 0) setKnownDuration(p.durationSeconds);
        return resumeStartSeconds(p);
      } catch {
        return 0; // no saved progress → start from the top
      }
    }

    function fail(message: string) {
      setStatus("error");
      setError(message);
    }

    /** Attach hls.js, with the recovery and link-measuring that on-demand HLS needs. */
    function attachHls(
      Hls: (typeof import("hls.js"))["default"],
      url: string,
      startPosition: number
    ) {
      const instance = new Hls(transcodeHlsConfig(startPosition));
      hls = instance;
      // Count CONSECUTIVE fatal errors (reset on any successful fragment): a fatal
      // error mid-transcode is usually just reaching the encoder's edge (segment
      // not written yet), so recover a few times before giving up.
      let consecutiveFatal = 0;
      // Buffer stalls, counted over a rolling window. Unlike a load failure, a
      // stall means the segments are arriving fine — just slower than they play —
      // which no amount of retrying fixes.
      let stalls = 0;
      let lastStallAt = 0;
      let steppedDown = false;
      // Rolling throughput, smoothed across fragments and reported back so "auto"
      // keeps tracking the connection for as long as playback lasts.
      let ewmaKbps = 0;
      let lastReportAt = 0;

      instance.on(Hls.Events.FRAG_BUFFERED, (_evt, data) => {
        consecutiveFatal = 0;
        const now = Date.now();
        // A whole window of clean playback since the last stall: the link
        // recovered, so stop telling the viewer it hasn't.
        if (lastStallAt > 0 && now - lastStallAt > STALL_WINDOW_MS) setLinkTooSlow(false);
        // Time from the FIRST byte, not from the request: a segment the encoder
        // hasn't reached yet spends its wait before that, and charging the
        // connection for ffmpeg's time would read as a slow link and shrink a
        // stream that was never the problem.
        const stats = data.stats;
        if (!stats?.loading.first || !stats.loading.end) return;
        if (stats.loaded < LINK_SAMPLE_MIN_BYTES) return;
        const ms = Math.max(stats.loading.end - stats.loading.first, LINK_SAMPLE_FLOOR_MS);
        const sample = (stats.loaded * 8) / ms;
        ewmaKbps = ewmaKbps === 0 ? sample : ewmaKbps * 0.7 + sample * 0.3;
        if (now - lastReportAt < LINK_REPORT_INTERVAL_MS) return;
        lastReportAt = now;
        linkKbpsRef.current(ewmaKbps);
      });

      instance.on(Hls.Events.ERROR, (_evt, data) => {
        if (cancelled || steppedDown) return;
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
          const now = Date.now();
          if (now - lastSeekAt < SEEK_STALL_GRACE_MS) return;
          stalls = now - lastStallAt > STALL_WINDOW_MS ? 1 : stalls + 1;
          lastStallAt = now;
          if (stalls < STALLS_BEFORE_STEP_DOWN) return;
          // Dropping a rung restarts the session from here, so this player is
          // about to be replaced — leave the old one alone.
          steppedDown = tooSlowRef.current();
          if (!steppedDown) setLinkTooSlow(true);
          return;
        }
        if (!data.fatal) return;
        if (consecutiveFatal < MAX_CONSECUTIVE_FATAL) {
          consecutiveFatal += 1;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) instance.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) instance.recoverMediaError();
          else fail("The transcode stream failed. The file may be unsupported.");
          return;
        }
        // Out of recovery attempts. If the fragments were failing to load, a
        // smaller stream is worth trying before calling the playback dead.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && tooSlowRef.current()) {
          steppedDown = true;
          return;
        }
        fail("The transcode stream failed. The file may be unsupported or ffmpeg errored.");
      });

      instance.loadSource(url);
      instance.attachMedia(video);
    }

    async function start() {
      try {
        // Resolve where to start BEFORE spawning ffmpeg, so it begins encoding there.
        const startSec = await resolveStart();
        if (cancelled) return;

        const res = await apiFetch<StartResponse>("/transcode", {
          method: "POST",
          body: JSON.stringify({
            type,
            id,
            ...(fileId != null ? { fileId } : {}),
            ...(audioTrack != null ? { audioTrack } : {}),
            ...(startSec > 0 ? { startSec } : {}),
            quality: quality.id,
          }),
        });
        sessionId = res.sessionId; // capture before any early return so cleanup can DELETE it
        // A seekable (VOD) transcode spans the WHOLE runtime, so the element's 0:00
        // is the film's 0:00: no base offset, and the playhead is placed at
        // `startSec` like direct play. The legacy event-playlist fallback (runtime
        // unprobeable) has its timeline shifted by `startSec`, so it keeps the offset.
        const seekable = res.seekable === true;
        setBaseOffset(seekable ? 0 : startSec);
        if (seekable && res.durationSec && res.durationSec > 0) setKnownDuration(res.durationSec);
        if (cancelled) return;

        const startPosition = seekable ? startSec : 0;
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;

        if (Hls.isSupported()) {
          attachHls(Hls, res.url, startPosition);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari / iOS play HLS natively; place the playhead once it knows the length.
          if (startPosition > 0) {
            video.addEventListener(
              "loadedmetadata",
              () => {
                try {
                  video.currentTime = startPosition;
                } catch {
                  /* not seekable yet — plays from the top */
                }
              },
              { once: true }
            );
          }
          video.src = res.url;
        } else {
          fail("Your browser cannot play HLS streams.");
          return;
        }
        setStatus("playing");
        void video.play?.().catch(() => {});
      } catch (err) {
        if (cancelled) return;
        const httpStatus = err instanceof ApiError ? err.status : 0;
        if (httpStatus === 503) {
          fail("Transcoding is unavailable — ffmpeg is not installed on the server.");
        } else if (httpStatus === 429) {
          fail("The server is at its transcoding capacity. Close another stream and retry.");
        } else {
          fail(err instanceof Error ? err.message : "Failed to start transcoding.");
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      window.clearInterval(watchdog);
      video.removeEventListener("seeking", onSeeking);
      hls?.destroy();
      if (sessionId) {
        // Raw fetch (204, no JSON body) with keepalive so it survives teardown.
        void fetch(`/api/v1/transcode/${sessionId}`, { method: "DELETE", keepalive: true }).catch(
          () => {}
        );
      }
    };
  }, [type, id, fileId, audioTrack, initialStartSec, disableProgress, quality.id]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="h-full w-full bg-black object-contain"
        onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime, e.currentTarget.duration)}
        onEnded={() => onEnded?.()}
      >
        <SubtitleTracks tracks={tracks} />
      </video>
      <SubtitleOverlay sinkRef={subtitleSinkRef} style={subtitleStyle} />
      {status === "starting" && (
        <div className="absolute inset-0 z-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-zinc-300">
          <Spinner className="size-6" />
          <span>Starting transcode…</span>
          {quality.id !== DEFAULT_TRANSCODE_QUALITY.id && (
            <span className="text-xs text-zinc-500">{quality.label} for your connection</span>
          )}
        </div>
      )}
      {linkTooSlow && status !== "error" && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-20 flex justify-center px-4">
          <Callout tone="warning" title="Connection too slow" className="max-w-md bg-zinc-900/90">
            <p>
              Playback keeps pausing to buffer at {quality.label}. The connection to the server is
              the limit here, not the file. {slowHint}
            </p>
          </Callout>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 z-0 flex items-center justify-center p-6">
          <Callout tone="danger" title="Playback error" className="max-w-md bg-zinc-900/90">
            {error}
          </Callout>
        </div>
      )}
    </>
  );
}

/** Seconds buffered contiguously ahead of `t`. */
function bufferedAhead(video: HTMLVideoElement, t: number): number {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.1 && video.buffered.end(i) > t) {
      return video.buffered.end(i) - t;
    }
  }
  return 0;
}
