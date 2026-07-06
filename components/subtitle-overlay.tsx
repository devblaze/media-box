"use client";

import { useEffect } from "react";
import { type SubtitleStyle, subtitleTextStyle } from "@/lib/subtitle-style";

/** A subtitle track (downloaded sidecar or embedded stream) from `GET /api/v1/subtitles`. */
export type SubtitleTrack = {
  id: string;
  kind?: "external" | "embedded";
  language: string;
  label: string;
  url: string;
};

/** Strip WebVTT inline markup (e.g. `<i>`, `<c.foo>`) to plain display text. */
function stripCueTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

/**
 * Drives the `<video>`'s TextTrack modes from the selected subtitle index
 * (`-1` = off) and pipes the active cue text into a styled overlay element
 * (`sinkRef`). The selected track is set to `hidden` — the browser still parses
 * its cues but does NOT paint them, leaving our own overlay as the sole, fully
 * user-styleable renderer.
 *
 * Instead of the browser's fixed cue timing we pick the active cue ourselves at
 * `currentTime - offsetSeconds`, so the viewer can nudge subtitle sync earlier
 * (negative) or later (positive) live. A small rAF loop keeps the overlay in
 * step and only writes to the DOM when the visible text actually changes.
 *
 * Shared by the on-demand media player and the live channel player.
 */
export function useStyledSubtitles(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  tracks: SubtitleTrack[],
  selectedIndex: number,
  offsetSeconds: number,
  sinkRef: React.RefObject<HTMLDivElement | null>
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const setModes = () => {
      const list = video.textTracks;
      for (let i = 0; i < list.length; i++) {
        list[i].mode = i === selectedIndex ? "hidden" : "disabled";
      }
    };

    const currentTrack = (): TextTrack | null => {
      const list = video.textTracks;
      return selectedIndex >= 0 && selectedIndex < list.length ? list[selectedIndex] : null;
    };

    // The cue text that should be showing at `t`, honouring the sync offset.
    const textAt = (t: number, track: TextTrack | null): string => {
      const cues = track?.cues;
      if (!cues || cues.length === 0) return "";
      const parts: string[] = [];
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i] as VTTCue;
        if (t >= c.startTime && t < c.endTime) parts.push(stripCueTags(c.text));
      }
      return parts.join("\n");
    };

    let raf = 0;
    let lastText = "";
    const tick = () => {
      const sink = sinkRef.current;
      if (sink) {
        const text =
          selectedIndex < 0 ? "" : textAt(video.currentTime - offsetSeconds, currentTrack());
        if (text !== lastText) {
          lastText = text;
          sink.textContent = text;
          sink.style.visibility = text ? "visible" : "hidden";
        }
      }
      raf = requestAnimationFrame(tick);
    };

    setModes();
    video.addEventListener("loadedmetadata", setModes);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("loadedmetadata", setModes);
    };
  }, [videoRef, tracks, selectedIndex, offsetSeconds, sinkRef]);
}

/** Subtitle `<track>` children shared by both players (modes set imperatively). */
export function SubtitleTracks({ tracks }: { tracks: SubtitleTrack[] }) {
  return (
    <>
      {tracks.map((t) => (
        <track key={t.id} kind="subtitles" src={t.url} srcLang={t.language} label={t.label} />
      ))}
    </>
  );
}

/** Bottom-centred overlay that shows the active cue in the viewer's chosen style. */
export function SubtitleOverlay({
  sinkRef,
  style,
}: {
  sinkRef: React.RefObject<HTMLDivElement | null>;
  style: SubtitleStyle;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[12%] z-[5] flex justify-center px-6">
      <div ref={sinkRef} style={{ ...subtitleTextStyle(style), visibility: "hidden" }} />
    </div>
  );
}
