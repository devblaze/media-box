"use client";

import { useEffect } from "react";
import { apiFetch } from "@/lib/api";
import type { PlaybackTarget, WatchProgress } from "./types";

/**
 * Minimum watched position before we record a resume point. A mis-click that
 * opens a title for a couple of seconds shouldn't land in Continue Watching.
 */
const MIN_PROGRESS_SECONDS = 10;
/** Throttle on progress saves during playback. */
const SAVE_EVERY_MS = 15_000;

export type WatchProgressOptions = {
  /** Don't save anything (a watch-together joiner is watching someone else's session). */
  disabled?: boolean;
  /**
   * Media-time of the video element's 0:00. A transcode started at `-ss N` has a
   * shifted timeline, so saves add N. `null` = not known yet — stay detached
   * until the owner resolves it.
   */
  offsetSeconds?: number | null;
  /**
   * Real duration of the MEDIA when the caller knows it. An event-HLS playlist's
   * `video.duration` only spans what ffmpeg has encoded so far — saving that
   * would understate durations and could falsely trip the 90%-watched mark.
   */
  knownDurationSeconds?: number;
  /**
   * Seek to the saved resume point once metadata loads. Off when the player has
   * already started the stream at the right place: seeking again then would only
   * throw away what it has just loaded.
   */
  resume?: boolean;
};

/**
 * Resume-on-open + throttled progress saving, shared by both players.
 *
 * On `loadedmetadata` it fetches the stored resume point and seeks to it (when it
 * is past the intro and before the ~95% "finished" mark). It PUTs progress at most
 * every ~15s during playback, once on `pause`, and once on unmount/close. Every
 * network call fails silently — playback never depends on it.
 */
export function useWatchProgress(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  target: PlaybackTarget,
  {
    disabled = false,
    offsetSeconds = 0,
    knownDurationSeconds = 0,
    resume = true,
  }: WatchProgressOptions = {}
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || disabled || offsetSeconds == null) return;

    const offset = offsetSeconds;
    const key = target.type === "movie" ? "movieId" : "episodeId";
    let disposed = false;
    let resumed = !resume || offset > 0; // offset streams already start at the resume point
    let lastSave = Date.now(); // defer the first throttled save so we never store 0

    const save = () => {
      const cur = video.currentTime;
      if (!Number.isFinite(cur)) return;
      const positionSeconds = Math.floor(offset + cur);
      if (positionSeconds < MIN_PROGRESS_SECONDS) return;
      const dur = video.duration;
      const durationSeconds =
        knownDurationSeconds > 0
          ? knownDurationSeconds
          : Math.floor(Number.isFinite(dur) && dur > 0 ? dur + offset : 0);
      lastSave = Date.now();
      void apiFetch("/watch-progress", {
        method: "PUT",
        body: JSON.stringify({ [key]: target.id, positionSeconds, durationSeconds }),
      }).catch(() => {});
    };

    const onLoadedMetadata = () => {
      if (resumed) return;
      resumed = true;
      void apiFetch<WatchProgress | null>(`/watch-progress?${key}=${target.id}`)
        .then((p) => {
          if (disposed || !p) return;
          const dur = video.duration;
          const beforeEnd = !Number.isFinite(dur) || p.positionSeconds < dur * 0.95;
          if (p.positionSeconds > 5 && beforeEnd) {
            try {
              video.currentTime = p.positionSeconds;
            } catch {
              /* seek rejected (e.g. not seekable yet) — start from the top */
            }
          }
        })
        .catch(() => {});
    };

    const onTimeUpdate = () => {
      if (Date.now() - lastSave >= SAVE_EVERY_MS) save();
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("pause", save);
    // Metadata may already be loaded before we attached (fast native playback).
    if (video.readyState >= 1) onLoadedMetadata();

    return () => {
      disposed = true;
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("pause", save);
      save(); // final flush on unmount / mode switch / close
    };
  }, [videoRef, target.type, target.id, disabled, offsetSeconds, knownDurationSeconds, resume]);
}
