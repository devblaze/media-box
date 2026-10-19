"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Callout } from "@/components/ui";
import type { SubtitleStyle } from "@/lib/subtitle-style";
import {
  SubtitleOverlay,
  SubtitleTracks,
  useStyledSubtitles,
  type SubtitleTrack,
} from "@/components/subtitle-overlay";
import { useRegisterVideo } from "./media-hooks";
import { useWatchProgress } from "./use-watch-progress";
import type { PlaybackTarget, TimeReport } from "./types";

/**
 * How long direct play may make no progress before the player says so, and
 * before it gives up. A file that arrives slower than it plays fires no `error`
 * event — the element simply waits for bytes — so these timers are the only
 * signal that a weak connection has stalled the stream for good.
 */
const SLOW_NOTICE_MS = 8_000;
const SLOW_HANDOVER_MS = 20_000;

/** Native direct play with a "Try transcoding" fallback on <video> error, and a
 *  watchdog that hands over to a transcode when the bytes can't keep up. */
export function DirectPlayer({
  target,
  fileId,
  startAt,
  tracks,
  selectedSub,
  subtitleStyle,
  subtitleOffset,
  onFallback,
  onTooSlow,
  onTime,
  onEnded,
  onVideoEl,
  disableProgress,
}: {
  target: PlaybackTarget;
  fileId: number | null;
  /** Where to start, when the caller knows (a hand-over from another stream, a
   *  watch-together joiner). Unset = resume from saved progress. */
  startAt?: number | null;
  tracks: SubtitleTrack[];
  selectedSub: number;
  subtitleStyle: SubtitleStyle;
  subtitleOffset: number;
  onFallback: () => void;
  /** Called when playback has stalled long enough that direct play won't recover. */
  onTooSlow: () => void;
  onTime?: TimeReport;
  onEnded?: () => void;
  onVideoEl?: (el: HTMLVideoElement | null) => void;
  disableProgress?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleSinkRef = useRef<HTMLDivElement>(null);
  const [errored, setErrored] = useState(false);
  const [stalled, setStalled] = useState(false);
  // Held in a ref so a caller passing an inline arrow can't restart the watchdog
  // (and reset its timers) on every parent render.
  const tooSlowRef = useRef(onTooSlow);
  useEffect(() => {
    tooSlowRef.current = onTooSlow;
  }, [onTooSlow]);

  // Progress watchdog. "Healthy" is: enough data buffered to keep playing, and
  // either advancing or deliberately paused. Everything else — buffering that
  // never completes, a playhead that stops moving — counts against the timers.
  useEffect(() => {
    let healthyAt = Date.now();
    let lastTime = -1;
    let hasPlayed = false;
    let handedOver = false;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || handedOver) return;
      const playable = v.readyState >= 3; // HAVE_FUTURE_DATA
      if (playable && !v.paused) hasPlayed = true;
      // Paused once playback got going is the viewer's doing, not a stall. Paused
      // BEFORE that means autoplay is still waiting on data — which is exactly the
      // case we're watching for.
      const waiting = !v.paused || (!hasPlayed && !playable);
      const healthy = playable && (v.paused || v.currentTime > lastTime + 0.05);
      lastTime = v.currentTime;
      const now = Date.now();
      if (!waiting || healthy) {
        healthyAt = now;
        setStalled(false);
        return;
      }
      const stuckMs = now - healthyAt;
      if (stuckMs >= SLOW_HANDOVER_MS) {
        handedOver = true;
        tooSlowRef.current();
      } else if (stuckMs >= SLOW_NOTICE_MS) {
        setStalled(true);
      }
    }, 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Start where the caller asked, once the element knows its length. Read once:
  // a later change of `startAt` comes with a new element anyway.
  const [initialStart] = useState(startAt ?? null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || initialStart == null || initialStart <= 0) return;
    const place = () => {
      try {
        video.currentTime = initialStart;
      } catch {
        /* not seekable — play from the top */
      }
    };
    if (video.readyState >= 1) place();
    else video.addEventListener("loadedmetadata", place, { once: true });
    return () => video.removeEventListener("loadedmetadata", place);
  }, [initialStart]);

  useWatchProgress(videoRef, target, { disabled: disableProgress, resume: initialStart == null });
  useStyledSubtitles(videoRef, tracks, selectedSub, subtitleOffset, subtitleSinkRef);
  useRegisterVideo(videoRef, onVideoEl);

  // A specific version streams from `?file=<id>`; the primary/default omits it.
  const src = `/api/v1/stream/${target.type}/${target.id}${fileId != null ? `?file=${fileId}` : ""}`;

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        preload="auto"
        className="h-full w-full bg-black object-contain"
        src={src}
        onError={() => setErrored(true)}
        onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime, e.currentTarget.duration)}
        onEnded={() => onEnded?.()}
      >
        <SubtitleTracks tracks={tracks} />
      </video>
      <SubtitleOverlay sinkRef={subtitleSinkRef} style={subtitleStyle} />
      {stalled && !errored && (
        <div className="pointer-events-auto absolute inset-x-0 top-20 z-20 flex justify-center px-4">
          <Callout tone="warning" title="Slow connection" className="max-w-md bg-zinc-900/90">
            <p>
              This file is arriving from the server more slowly than it plays. Switching to a stream
              sized for your connection…
            </p>
            <div className="mt-2">
              <Button size="sm" onClick={() => tooSlowRef.current()}>
                Switch now
              </Button>
            </div>
          </Callout>
        </div>
      )}
      {errored && (
        <div className="absolute inset-0 z-0 flex items-center justify-center p-6">
          <Callout tone="warning" title="Direct play failed" className="max-w-md bg-zinc-900/90">
            <p>
              Your browser could not play this file directly. MP4/H.264/AAC plays natively; MKV,
              HEVC and other formats need transcoding.
            </p>
            <div className="mt-2">
              <Button size="sm" onClick={onFallback}>
                Try transcoding
              </Button>
            </div>
          </Callout>
        </div>
      )}
    </>
  );
}
