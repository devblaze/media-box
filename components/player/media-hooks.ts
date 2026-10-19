"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SeekCoalescer, type SeekBurst } from "@/lib/seek-coalescer";

/** The transport state the control bar draws from, read off the live element. */
export type MediaState = {
  paused: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  /** Should be playing (or is seeking) and is waiting for data to do it. */
  buffering: boolean;
};

const MEDIA_EVENTS = [
  "play",
  "pause",
  "playing",
  "waiting",
  "seeking",
  "seeked",
  "canplay",
  "loadstart",
  "emptied",
  "ended",
  "volumechange",
  "ratechange",
] as const;

const IDLE: MediaState = {
  paused: true,
  muted: false,
  volume: 1,
  playbackRate: 1,
  buffering: false,
};

/**
 * The element's transport state, kept in step with it however it changed — the
 * control bar, a keyboard shortcut, a watch-together command, an autoplay policy.
 * The snapshot is a string so React can compare it cheaply; it's parsed once per
 * change.
 */
export function useMediaState(video: HTMLVideoElement | null): MediaState {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!video) return () => {};
      for (const e of MEDIA_EVENTS) video.addEventListener(e, onChange);
      return () => {
        for (const e of MEDIA_EVENTS) video.removeEventListener(e, onChange);
      };
    },
    [video]
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (video ? encode(video) : ""),
    () => ""
  );
  return useMemo(() => decode(snapshot), [snapshot]);
}

function encode(v: HTMLVideoElement): string {
  const buffering = v.seeking || (!v.paused && !v.ended && v.readyState < 3);
  return [+v.paused, +v.muted, +buffering, v.volume, v.playbackRate].join("|");
}

function decode(snapshot: string): MediaState {
  if (!snapshot) return IDLE;
  const [paused, muted, buffering, volume, rate] = snapshot.split("|");
  return {
    paused: paused === "1",
    muted: muted === "1",
    buffering: buffering === "1",
    volume: Number(volume),
    playbackRate: Number(rate),
  };
}

/**
 * One seek path for every control: the scrubber, the skip buttons, the arrow keys.
 * Quick skips add up and go out as a single seek (see {@link SeekCoalescer});
 * `burst` is what to draw meanwhile — the target the bar should show, and the
 * running total for the on-screen bubble.
 */
export function useSeeker(video: HTMLVideoElement | null) {
  const [burst, setBurst] = useState<SeekBurst>(null);
  const [seeker] = useState(() => new SeekCoalescer(setBurst));

  // A new element (another stream, another episode) starts with nothing queued.
  useEffect(() => {
    seeker.attach(video);
    return () => seeker.attach(null);
  }, [video, seeker]);

  return { seeker, burst };
}

/** Publish a child player's <video> up to the modal, which drives its controls. */
export function useRegisterVideo(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onVideoEl?: (el: HTMLVideoElement | null) => void
) {
  useEffect(() => {
    onVideoEl?.(videoRef.current);
    return () => onVideoEl?.(null);
  }, [videoRef, onVideoEl]);
}
