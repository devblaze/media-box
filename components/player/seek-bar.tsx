"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { fmtClock } from "./format";
import type { SkipSegment } from "./types";

const TIME_EVENTS = ["timeupdate", "progress", "seeking", "seeked", "durationchange", "emptied"];

/**
 * Where the element is and what it has buffered, as one comparable string. Rounded
 * to a tenth of a second (and whole seconds for ranges), so it changes about as
 * often as a frame of the bar would visibly move.
 */
function useTimeline(video: HTMLVideoElement | null) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!video) return () => {};
      for (const e of TIME_EVENTS) video.addEventListener(e, onChange);
      return () => {
        for (const e of TIME_EVENTS) video.removeEventListener(e, onChange);
      };
    },
    [video]
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => {
      if (!video) return "0|";
      const ranges: string[] = [];
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push(`${Math.floor(video.buffered.start(i))}-${Math.ceil(video.buffered.end(i))}`);
      }
      return `${video.currentTime.toFixed(1)}|${ranges.join(",")}`;
    },
    () => "0|"
  );
  return useMemo(() => {
    const [time, ranges] = snapshot.split("|");
    return {
      time: Number(time),
      buffered: ranges
        ? ranges.split(",").map((r) => r.split("-").map(Number) as [number, number])
        : [],
    };
  }, [snapshot]);
}

/**
 * The control bar's scrubber: what's played, what's buffered, intro/recap marks,
 * and the time under the pointer. Dragging previews locally and seeks once on
 * release, so scrubbing never fires a seek per pixel. Arrow keys are the player's
 * global skip shortcuts, so focusing the bar needs no key handling of its own.
 */
export function SeekBar({
  video,
  duration,
  pendingTime,
  markers,
  onSeek,
  onActivity,
}: {
  video: HTMLVideoElement | null;
  /** Seconds the bar spans (the probed runtime; a live transcode's own is partial). */
  duration: number;
  /** A seek that's been asked for but hasn't landed: draw the bar there meanwhile. */
  pendingTime: number | null;
  markers: SkipSegment[];
  onSeek: (t: number) => void;
  /** Any interaction, so the controls stay up while the viewer is using them. */
  onActivity: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const { time, buffered } = useTimeline(video);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const span = duration > 0 ? duration : 0;
  const shown = drag ?? pendingTime ?? time;
  const pct = (t: number) => (span > 0 ? `${Math.min(100, Math.max(0, (t / span) * 100))}%` : "0%");

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || span === 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { x: ratio * rect.width, t: ratio * span };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const at = timeAt(e.clientX);
    if (!at) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(at.t);
    onActivity();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const at = timeAt(e.clientX);
    setHover(at);
    if (at && drag != null) setDrag(at.t);
    onActivity();
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag == null) return;
    const at = timeAt(e.clientX);
    onSeek(at ? at.t : drag);
    setDrag(null);
  };

  const active = drag != null || hover != null;

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.floor(span)}
      aria-valuenow={Math.floor(shown)}
      aria-valuetext={`${fmtClock(shown)} of ${fmtClock(span)}`}
      aria-disabled={span === 0}
      className={cn(
        "group relative flex h-5 w-full touch-none items-center outline-none select-none",
        span > 0 ? "cursor-pointer" : "cursor-default"
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div
        ref={trackRef}
        className={cn(
          "relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] duration-150 group-focus-visible:h-1.5",
          active && "h-1.5"
        )}
      >
        {buffered.map(([start, end]) => (
          <div
            key={`${start}-${end}`}
            className="absolute inset-y-0 bg-white/35"
            style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }}
          />
        ))}
        {hover && drag == null && (
          <div className="absolute inset-y-0 left-0 bg-white/20" style={{ width: hover.x }} />
        )}
        <div className="absolute inset-y-0 left-0 bg-amber-500" style={{ width: pct(shown) }} />
        {markers.map((m) => (
          <div
            key={`${m.type}-${m.startSeconds}`}
            title={m.label}
            className="absolute inset-y-0 bg-sky-300/70"
            style={{
              left: pct(m.startSeconds),
              width: `calc(${pct(m.endSeconds)} - ${pct(m.startSeconds)})`,
            }}
          />
        ))}
      </div>

      {/* Thumb */}
      <div
        className={cn(
          "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 shadow transition-transform duration-150",
          active ? "scale-100" : "scale-0 group-focus-visible:scale-100"
        )}
        style={{ left: pct(shown) }}
      />

      {/* Time under the pointer (or the drag target). */}
      {span > 0 && (drag != null || hover) && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded bg-black/85 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white shadow"
          style={{ left: drag != null ? pct(drag) : hover!.x }}
        >
          {fmtClock(drag ?? hover!.t)}
        </div>
      )}
    </div>
  );
}
