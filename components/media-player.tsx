"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch, ApiError } from "@/lib/api";
import { Badge, Button, Callout, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  loadSubtitleStyle,
  subtitleTextStyle,
  type SubtitleStyle,
} from "@/lib/subtitle-style";
import type { MediaInfo } from "@/server/library/media-info";

// Type-only import of the hls.js instance type. The runtime class is loaded via
// a dynamic `import("hls.js")` inside the player effect so it is code-split out
// of the main bundle and never evaluated during SSR.
type HlsInstance = InstanceType<(typeof import("hls.js"))["default"]>;

// ---- pretty-printing helpers ----

const VIDEO_CODEC_LABELS: Record<string, string> = {
  h264: "H.264",
  avc: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  mpeg4: "MPEG-4",
  mpeg2video: "MPEG-2",
  vc1: "VC-1",
};

const AUDIO_CODEC_LABELS: Record<string, string> = {
  aac: "AAC",
  ac3: "AC3",
  eac3: "EAC3",
  dts: "DTS",
  truehd: "TrueHD",
  flac: "FLAC",
  opus: "Opus",
  vorbis: "Vorbis",
  mp3: "MP3",
  pcm_s16le: "PCM",
};

function labelCodec(codec: string, map: Record<string, string>): string {
  const key = codec.toLowerCase();
  return map[key] ?? codec.toUpperCase();
}

function resolutionLabel(width: number | null, height: number | null): string | null {
  const p = height ?? (width ? Math.round((width * 9) / 16) : null);
  if (!p) return null;
  if (p >= 4320) return "8K";
  if (p >= 2160) return "4K";
  if (p >= 1440) return "1440p";
  if (p >= 1080) return "1080p";
  if (p >= 720) return "720p";
  if (p >= 480) return "480p";
  return `${p}p`;
}

function channelLabel(channels: number | null): string | null {
  if (channels == null) return null;
  if (channels === 1) return "1.0";
  if (channels === 2) return "2.0";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels}ch`;
}

/** Compact media-technical badges (codec / resolution / audio / HDR / subs). */
export function MediaInfoBadges({
  info,
  className,
}: {
  info: MediaInfo | null | undefined;
  className?: string;
}) {
  if (!info) return null;

  const res = info.video ? resolutionLabel(info.video.width, info.video.height) : null;
  const audioCh = info.audio ? channelLabel(info.audio.channels) : null;

  return (
    <div className={className ?? "flex flex-wrap items-center gap-1.5"}>
      {info.video && (
        <Badge tone="neutral">
          {labelCodec(info.video.codec, VIDEO_CODEC_LABELS)}
          {res ? ` · ${res}` : ""}
        </Badge>
      )}
      {info.video?.hdr && <Badge tone="accent">{info.video.hdr}</Badge>}
      {info.audio && (
        <Badge tone="neutral">
          {labelCodec(info.audio.codec, AUDIO_CODEC_LABELS)}
          {audioCh ? ` ${audioCh}` : ""}
        </Badge>
      )}
      {info.subtitles.length > 0 && (
        <Badge tone="neutral">
          {info.subtitles.length} sub{info.subtitles.length > 1 ? "s" : ""}
        </Badge>
      )}
    </div>
  );
}

export type PlaybackTarget = { type: "movie" | "episode"; id: number };

/** Two-digit zero-padded number, e.g. 3 → "03". */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The previous / next PLAYABLE episode relative to the one now playing, as served
 * by `GET /api/v1/episodes/{id}/neighbors`. `null` when there is no such neighbor.
 */
type Neighbor = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  seriesTitle: string;
};

/** Human label for a neighbor, e.g. "Show · S01E02 · The Title". */
function neighborLabel(n: Neighbor): string {
  return `${n.seriesTitle} · S${pad2(n.seasonNumber)}E${pad2(n.episodeNumber)}${
    n.title ? ` · ${n.title}` : ""
  }`;
}

/** How early (seconds before the end) the auto-advance "Up next" card appears. */
const UP_NEXT_LEAD_SECONDS = 25;
/** Seconds the "Up next" auto-advance countdown starts from. */
const UP_NEXT_COUNTDOWN = 10;

// Containers a browser can demux natively (MKV/AVI/TS always need transcoding).
const NATIVE_CONTAINERS = new Set(["mp4", "m4v", "mov", "webm"]);
// Audio codecs browsers can decode (AC3/EAC3/DTS/TrueHD can't → transcode).
const WEB_AUDIO = new Set(["aac", "mp4a", "mp3", "opus", "vorbis", "flac"]);
// SSR fallback baseline (no DOM to probe): the near-universal H.264/AAC set.
const DIRECT_VIDEO = new Set(["h264", "avc", "avc1"]);
const DIRECT_AUDIO = new Set(["aac", "mp4a"]);

/** RFC-6381 codecs MIME for `canPlayType`, from probed codec names (best-effort). */
function directMime(info: MediaInfo): string | null {
  const c = info.container.toLowerCase();
  const mime = c === "webm" ? "video/webm" : NATIVE_CONTAINERS.has(c) ? "video/mp4" : null;
  if (!mime) return null;
  const codecs: string[] = [];
  const v = (info.video?.codec ?? "").toLowerCase();
  if (["h264", "avc", "avc1"].includes(v)) codecs.push("avc1.640029");
  else if (["hevc", "h265", "hvc1", "hev1"].includes(v)) codecs.push("hvc1.1.6.L120.90");
  else if (v === "av1") codecs.push("av01.0.08M.08");
  else if (["vp9", "vp09"].includes(v)) codecs.push("vp09.00.10.08");
  else if (v) return null; // unknown video codec — don't risk direct play
  const a = (info.audio?.codec ?? "").toLowerCase();
  if (a === "aac" || a === "mp4a") codecs.push("mp4a.40.2");
  else if (a === "mp3") codecs.push("mp4a.69");
  else if (a === "opus") codecs.push("opus");
  else if (a === "vorbis") codecs.push("vorbis");
  else if (a === "flac") codecs.push("flac");
  return `${mime}; codecs="${codecs.join(",")}"`;
}

/**
 * Decide whether THIS device can play the file natively. Container must be
 * browser-demuxable and audio web-decodable; then we ask the real `<video>`
 * element (`canPlayType`) about the codecs — so a Mac that decodes HEVC direct-
 * plays it while a device that can't gets transcoded. No MediaInfo → optimistic
 * direct with the transcode fallback on error.
 */
function canDirectPlay(info: MediaInfo | null | undefined): boolean {
  if (!info) return true;
  const container = info.container.toLowerCase();
  if (!NATIVE_CONTAINERS.has(container)) return false;
  const acodec = (info.audio?.codec ?? "").toLowerCase();
  if (acodec && !WEB_AUDIO.has(acodec)) return false;
  if (typeof document === "undefined") {
    // Server render — no element to probe; use the safe H.264/AAC baseline.
    const vcodec = (info.video?.codec ?? "").toLowerCase();
    return DIRECT_VIDEO.has(vcodec) && (!acodec || DIRECT_AUDIO.has(acodec));
  }
  const mime = directMime(info);
  if (!mime) return false;
  const support = document.createElement("video").canPlayType(mime);
  return support === "probably" || support === "maybe";
}

/** A downloaded subtitle sidecar, as served by `GET /api/v1/subtitles`. */
type SubtitleTrack = { id: number; language: string; label: string; url: string };

/** Shape of `GET /api/v1/watch-progress` (or `null` when nothing is stored). */
type WatchProgress = { positionSeconds: number; durationSeconds: number; watched: boolean };

/**
 * A selectable file version (quality) for the current title, from
 * `GET /api/v1/versions`. Movies can have several (e.g. a 1080p + a 4K); episodes
 * return a single entry. `resolution` is a short tag ("4K"/"1080p"); `label` is
 * fuller (e.g. "4K · WEB-DL-2160p").
 */
type MediaVersion = {
  fileId: number;
  resolution: string;
  label: string;
  size: number;
  isPrimary: boolean;
};

/**
 * Coarse quality tag derived from a raw pixel height. Used only as a fallback
 * chip label when the versions list could not be fetched.
 */
function qualityTagFromHeight(height: number | null | undefined): string | null {
  if (height == null) return null;
  if (height >= 2160) return "4K";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return "SD";
}

// ---- fullscreen helpers (defensive against browsers without the promise API) ----

function enterFullscreen(el: HTMLElement | null) {
  try {
    const p = el?.requestFullscreen?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* fullscreen unsupported or rejected — keep playing windowed */
  }
}

function exitFullscreen() {
  try {
    if (typeof document !== "undefined" && document.fullscreenElement) {
      const p = document.exitFullscreen?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

/**
 * Resume-on-open + throttled progress saving, shared by both player modes so the
 * logic lives in one place and the hook order stays stable regardless of mode.
 *
 * On `loadedmetadata` it fetches the stored resume point and seeks to it (when
 * it is past the intro and before the ~95% "finished" mark). It PUTs progress at
 * most every ~15s during playback, once on `pause`, and once on unmount/close.
 * Every network call fails silently — playback never depends on it.
 */
function useWatchProgress(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  target: PlaybackTarget
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const key = target.type === "movie" ? "movieId" : "episodeId";
    let disposed = false;
    let resumed = false;
    let lastSave = Date.now(); // defer the first throttled save ~15s so we never store 0

    const save = () => {
      const cur = video.currentTime;
      const positionSeconds = Math.floor(cur);
      if (!Number.isFinite(cur) || positionSeconds <= 0) return; // guard 0 / NaN
      const dur = video.duration;
      const durationSeconds = Math.floor(Number.isFinite(dur) && dur > 0 ? dur : 0);
      lastSave = Date.now();
      void apiFetch("/watch-progress", {
        method: "PUT",
        body: JSON.stringify({ [key]: target.id, positionSeconds, durationSeconds }),
      }).catch(() => {});
    };

    const onLoadedMetadata = () => {
      if (resumed) return; // resume at most once per mount
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
      if (Date.now() - lastSave >= 15_000) save();
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
  }, [videoRef, target.type, target.id]);
}

/** Strip WebVTT inline markup (e.g. `<i>`, `<c.foo>`) to plain display text. */
function stripCueTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

/** Subtitle-sync nudge, in seconds, per button press / keypress. */
const SUBTITLE_OFFSET_STEP = 0.1;
/** Clamp the sync offset so it can never run away. */
const SUBTITLE_OFFSET_MAX = 60;

/** e.g. 0 → "0.0s", 0.5 → "+0.5s", -0.3 → "-0.3s". */
function formatOffset(sec: number): string {
  return `${sec > 0 ? "+" : ""}${sec.toFixed(1)}s`;
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
 */
function useStyledSubtitles(
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
function SubtitleTracks({ tracks }: { tracks: SubtitleTrack[] }) {
  return (
    <>
      {tracks.map((t) => (
        <track key={t.id} kind="subtitles" src={t.url} srcLang={t.language} label={t.label} />
      ))}
    </>
  );
}

/** Bottom-centred overlay that shows the active cue in the viewer's chosen style. */
function SubtitleOverlay({
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

/**
 * Immersive, Netflix-style player. It plays a title either by DIRECT play (native
 * `<video>` on the gated stream route) or by TRANSCODE (server-side HLS via
 * ffmpeg, loaded with hls.js). The initial mode is chosen from {@link MediaInfo};
 * an overlay toggle lets the user switch, and a failed direct play offers a
 * one-click transcode fallback.
 *
 * Presentation is a full-window black overlay that fills the whole browser page
 * but stays windowed — the browser chrome/tabs remain visible. Native fullscreen
 * is opt-in only, via the bottom-right maximize button or the `F` key. A top-left
 * Back control returns to the page, and a bottom-right cluster (Direct/Transcode
 * toggle, subtitles, and the fullscreen toggle) auto-hides after a few seconds of
 * no mouse movement. `F` toggles fullscreen; `Esc` exits fullscreen or closes.
 *
 * Mount it only while a title is selected so state resets between plays.
 */
export function VideoPlayerModal({
  target,
  title,
  mediaInfo,
  onClose,
}: {
  target: PlaybackTarget;
  title: React.ReactNode;
  mediaInfo?: MediaInfo | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"direct" | "transcode">(() =>
    canDirectPlay(mediaInfo) ? "direct" : "transcode"
  );

  // The title actually playing. Starts as the opened `target` but, for episodes,
  // can move to an adjacent episode via prev/next or the auto-advance "Up next"
  // card. Everything that streams or persists progress reads `current`, not the
  // `target` prop, so navigating loads the neighbour without remounting the modal.
  const [current, setCurrent] = useState<PlaybackTarget>(target);
  const [currentTitle, setCurrentTitle] = useState<React.ReactNode>(title);

  // Adjacent playable episodes (episode targets only) and the auto-advance card
  // state. `upNextCancelled` suppresses auto-advance for the current episode only.
  const [neighbors, setNeighbors] = useState<{ prev: Neighbor | null; next: Neighbor | null }>({
    prev: null,
    next: null,
  });
  const [upNextVisible, setUpNextVisible] = useState(false);
  const [upNextCancelled, setUpNextCancelled] = useState(false);
  const [countdown, setCountdown] = useState(UP_NEXT_COUNTDOWN);

  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [ccOpen, setCcOpen] = useState(false);
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [selectedSub, setSelectedSub] = useState(-1); // -1 = off (default)
  // The viewer's saved caption appearance, read once when the player opens.
  const [subtitleStyle] = useState<SubtitleStyle>(() => loadSubtitleStyle());
  // Subtitle sync offset in seconds (+ = later, − = earlier), nudged live with
  // the [ / ] keys or the CC-menu buttons. A brief OSD flashes on each change.
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  const [offsetOsd, setOffsetOsd] = useState(false);
  const osdTimer = useRef<number | null>(null);

  // Available file versions (qualities) and the one currently playing. `null`
  // fileId means "server default/primary" (used until the list resolves, or when
  // the fetch fails and we treat the title as a single default version).
  const [versions, setVersions] = useState<MediaVersion[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);

  // The overlay is portaled to <body>. Without this, the player is a React child
  // of whatever card opened it, and clicks bubble (through the React tree) to that
  // card's onClick/Link — which made a click on the video "exit to home".
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const barVisible = controlsVisible || ccOpen || qualityOpen;

  // Opens windowed (full-page overlay, browser chrome still visible). Native
  // fullscreen is opt-in via the maximize button / `F` — no auto-request here.

  // Fetch available subtitle tracks for the current title (silent on failure).
  // Refetches whenever `current` changes (e.g. navigating to a neighbour episode).
  useEffect(() => {
    const key = current.type === "movie" ? "movieId" : "episodeId";
    let active = true;
    void apiFetch<{ tracks: SubtitleTrack[] }>(`/subtitles?${key}=${current.id}`)
      .then((res) => {
        if (active) setTracks(res.tracks ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [current.type, current.id]);

  // Fetch the available file versions for the current title. Silent on failure —
  // we then treat it as a single default version (no picker, fileId stays null).
  // Refetches whenever `current` changes (e.g. navigating to a neighbour episode).
  useEffect(() => {
    const type = current.type === "movie" ? "movie" : "episode";
    let active = true;
    void apiFetch<{ versions: MediaVersion[] }>(`/versions?type=${type}&id=${current.id}`)
      .then((res) => {
        if (!active) return;
        const list = res.versions ?? [];
        setVersions(list);
        const primary = list.find((v) => v.isPrimary) ?? list[0] ?? null;
        setSelectedFileId(primary ? primary.fileId : null);
      })
      .catch(() => {
        /* no versions endpoint / error — leave as a single default version */
      });
    return () => {
      active = false;
    };
  }, [current.type, current.id]);

  // Fetch the previous/next playable episode for the current episode. Movies have
  // no neighbours (and `current.type` never changes for a movie target, so the
  // default {null,null} stands). Refetches whenever `current.id` changes.
  useEffect(() => {
    if (current.type !== "episode") return;
    let active = true;
    void apiFetch<{ prev: Neighbor | null; next: Neighbor | null }>(
      `/episodes/${current.id}/neighbors`
    )
      .then((res) => {
        if (active) setNeighbors({ prev: res.prev ?? null, next: res.next ?? null });
      })
      .catch(() => {
        if (active) setNeighbors({ prev: null, next: null });
      });
    return () => {
      active = false;
    };
  }, [current.type, current.id]);

  // Navigate to an adjacent episode: point `current` at it and reset every
  // per-title bit of state so it loads fresh (mode back to a direct-play attempt,
  // default version, no subtitle selection, no lingering up-next card). The
  // versions/subtitles/neighbours effects above refetch off the new `current`.
  const goTo = useCallback((n: Neighbor) => {
    setCurrent({ type: "episode", id: n.id });
    setCurrentTitle(neighborLabel(n));
    setMode("direct");
    setSelectedFileId(null);
    setVersions([]);
    setSelectedSub(-1);
    setSubtitleOffset(0);
    setTracks([]);
    setNeighbors({ prev: null, next: null });
    setUpNextVisible(false);
    setUpNextCancelled(false);
    setCountdown(UP_NEXT_COUNTDOWN);
  }, []);

  // Video progress reported up from the active child player. When we're within the
  // last stretch of an episode that has a next neighbour (and the viewer hasn't
  // dismissed it), reveal the auto-advance "Up next" card.
  const handleTime = useCallback(
    (currentTime: number, duration: number) => {
      if (current.type !== "episode" || !neighbors.next || upNextCancelled) return;
      if (duration > 0 && currentTime >= duration - UP_NEXT_LEAD_SECONDS) {
        setUpNextVisible(true);
      }
    },
    [current.type, neighbors.next, upNextCancelled]
  );

  // The video finished. If a next episode exists and auto-advance wasn't cancelled,
  // jump straight to it; otherwise leave the default end-of-video behaviour.
  const handleEnded = useCallback(() => {
    if (current.type === "episode" && neighbors.next && !upNextCancelled) {
      goTo(neighbors.next);
    }
  }, [current.type, neighbors.next, upNextCancelled, goTo]);

  // While the "Up next" card is showing, tick a once-per-second wall-clock
  // countdown (it enters at UP_NEXT_COUNTDOWN — the state default, reset on every
  // navigation) and auto-advance to the next episode when it reaches zero. The
  // interval is cleared on hide / unmount / navigation (all flip `upNextVisible`).
  useEffect(() => {
    const next = neighbors.next;
    if (!upNextVisible || !next) return;
    let remaining = UP_NEXT_COUNTDOWN;
    const timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(timer);
        goTo(next);
      } else {
        setCountdown(remaining);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [upNextVisible, neighbors.next, goTo]);

  // Keep the max/min icon in sync with the actual fullscreen state.
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  useEffect(() => {
    showControls();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [showControls]);

  const handleClose = useCallback(() => {
    exitFullscreen();
    onClose();
  }, [onClose]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) exitFullscreen();
    else enterFullscreen(containerRef.current);
    showControls();
  }, [showControls]);

  // Flash the subtitle-offset OSD for ~1.2s so keyboard nudges give feedback.
  const flashOffset = useCallback(() => {
    setOffsetOsd(true);
    if (osdTimer.current) window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOffsetOsd(false), 1200);
  }, []);

  const nudgeOffset = useCallback(
    (delta: number) => {
      setSubtitleOffset((o) => {
        const clamped = Math.min(SUBTITLE_OFFSET_MAX, Math.max(-SUBTITLE_OFFSET_MAX, o + delta));
        return Math.round(clamped * 10) / 10; // keep to one decimal, no float drift
      });
      flashOffset();
    },
    [flashOffset]
  );

  const resetOffset = useCallback(() => {
    setSubtitleOffset(0);
    flashOffset();
  }, [flashOffset]);

  useEffect(() => {
    return () => {
      if (osdTimer.current) window.clearTimeout(osdTimer.current);
    };
  }, []);

  // F toggles fullscreen; Esc exits fullscreen first, otherwise closes;
  // [ / ] nudge subtitle sync earlier / later (only while a subtitle is on).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "Escape") {
        if (document.fullscreenElement) exitFullscreen();
        else handleClose();
      } else if (e.key === "[" && selectedSub >= 0) {
        e.preventDefault();
        nudgeOffset(-SUBTITLE_OFFSET_STEP);
      } else if (e.key === "]" && selectedSub >= 0) {
        e.preventDefault();
        nudgeOffset(SUBTITLE_OFFSET_STEP);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen, handleClose, nudgeOffset, selectedSub]);

  // The currently-playing version (if the list resolved) and the label for the
  // always-on quality chip. Prefer the selected version's short tag; otherwise
  // fall back to a tag derived from the probed height; hide it if nothing known.
  const selectedVersion = versions.find((v) => v.fileId === selectedFileId) ?? null;
  const qualityChip = selectedVersion?.resolution ?? qualityTagFromHeight(mediaInfo?.video?.height);

  const overlay = (
    <div
      ref={containerRef}
      className={cn(
        "fixed inset-0 z-[60] flex items-center justify-center bg-black",
        !barVisible && "cursor-none"
      )}
      onMouseMove={showControls}
      // The portal moves this to <body> in the DOM, but React still bubbles events
      // to the component that rendered the player (e.g. the card you clicked Play
      // on). Stop clicks here so a click inside the player — including the one that
      // refocuses the window — never reaches that card and closes/navigates it.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Keying by the selected fileId remounts the player when the version
          changes, which re-inits the source (and, via the shared hooks, saves the
          old position then resumes it on the newly-loaded stream). */}
      {mode === "direct" ? (
        <DirectPlayer
          key={`${current.type}-${current.id}-${selectedFileId ?? "default"}`}
          target={current}
          fileId={selectedFileId}
          tracks={tracks}
          selectedSub={selectedSub}
          subtitleStyle={subtitleStyle}
          subtitleOffset={subtitleOffset}
          onFallback={() => setMode("transcode")}
          onTime={handleTime}
          onEnded={handleEnded}
        />
      ) : (
        <TranscodePlayer
          key={`${current.type}-${current.id}-${selectedFileId ?? "default"}`}
          target={current}
          fileId={selectedFileId}
          tracks={tracks}
          selectedSub={selectedSub}
          subtitleStyle={subtitleStyle}
          subtitleOffset={subtitleOffset}
          onTime={handleTime}
          onEnded={handleEnded}
        />
      )}

      {/* Subtitle-sync OSD — flashes on each [ / ] nudge or button press. */}
      {offsetOsd && (
        <div className="pointer-events-none absolute inset-x-0 top-1/4 z-20 flex justify-center">
          <div className="rounded-lg bg-black/70 px-4 py-2 text-sm font-medium text-white shadow-lg backdrop-blur">
            Subtitle delay {formatOffset(subtitleOffset)}
          </div>
        </div>
      )}

      {/* Auto-advance "Up next" card — bottom-right, above the control cluster.
          Shows in the final stretch (or at end) of an episode that has a next
          neighbour, unless the viewer cancelled it. Stays visible even when the
          controls have auto-hidden. */}
      {current.type === "episode" && upNextVisible && neighbors.next && (
        <div className="pointer-events-auto absolute right-3 bottom-28 z-20 w-72 max-w-[calc(100%-1.5rem)] rounded-lg border border-white/10 bg-zinc-900/95 p-4 shadow-xl backdrop-blur sm:right-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Up next</p>
          <p className="mt-1 line-clamp-2 text-sm font-semibold text-white">
            {neighborLabel(neighbors.next)}
          </p>
          <p className="mt-2 text-xs text-zinc-400" aria-live="polite">
            Playing in {Math.max(0, countdown)}s…
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => neighbors.next && goTo(neighbors.next)}>
              Play now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setUpNextVisible(false);
                setUpNextCancelled(true);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Top-left: Back button + title. Auto-hides, reappears on mouse move. */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-3 py-3 pb-10 transition-opacity duration-300 sm:px-4 sm:gap-3",
          barVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <button
          type="button"
          onClick={handleClose}
          aria-label="Back"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 font-semibold text-white outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-amber-500/50"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-7 sm:size-8"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="text-base sm:text-lg">Back</span>
        </button>

        <div className="min-w-0 flex-1 truncate text-base font-semibold text-white sm:text-lg">
          {currentTitle}
        </div>
      </div>

      {/* Bottom control cluster — Direct/Transcode, CC (opens upward), fullscreen.
          The wrapper is click-through so it never blocks the native <video>
          controls; only the chip itself captures pointer events, and it sits
          above the native control bar. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300",
          barVisible ? "opacity-100" : "opacity-0"
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />

        <div
          className={cn(
            "absolute right-3 bottom-16 flex items-center gap-2 rounded-lg bg-black/50 p-1.5 backdrop-blur-sm sm:right-4",
            barVisible ? "pointer-events-auto" : "pointer-events-none"
          )}
        >
          {/* Previous / Next episode (episodes only) — disabled when no neighbour. */}
          {current.type === "episode" && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                disabled={!neighbors.prev}
                onClick={() => {
                  if (neighbors.prev) goTo(neighbors.prev);
                  showControls();
                }}
                aria-label="Previous episode"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6L9 12l9 6V6z" />
                  <line x1="6" y1="6" x2="6" y2="18" />
                </svg>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={!neighbors.next}
                onClick={() => {
                  if (neighbors.next) goTo(neighbors.next);
                  showControls();
                }}
                aria-label="Next episode"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l9 6-9 6V6z" />
                  <line x1="18" y1="6" x2="18" y2="18" />
                </svg>
              </Button>
            </div>
          )}

          {/* Playback mode is chosen automatically from the file + this device's
              codec support (falling back to transcode if direct play errors), so
              there's no manual toggle — just a read-only note while transcoding. */}
          {mode === "transcode" && (
            <span
              className="rounded-md border border-white/15 px-2 py-1 text-xs font-medium text-zinc-300"
              title="This file isn't natively playable on this device, so it's being transcoded on the fly."
            >
              Transcoding
            </span>
          )}

          {/* Current-quality chip — always shown when a quality is known. */}
          {qualityChip && (
            <span
              className="rounded-md border border-white/15 px-2 py-1 text-xs font-medium text-zinc-200"
              aria-label={`Current quality ${qualityChip}`}
            >
              {qualityChip}
            </span>
          )}

          {/* Quality (version) picker — only when there's more than one version.
              Menu opens upward so it isn't clipped at the edge. */}
          {versions.length > 1 && (
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setQualityOpen((o) => !o);
                  setCcOpen(false);
                  showControls();
                }}
                aria-label="Quality"
                aria-haspopup="menu"
                aria-expanded={qualityOpen}
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 3l9 5-9 5-9-5 9-5z" />
                  <path d="M3 13l9 5 9-5" />
                </svg>
              </Button>
              {qualityOpen && (
                <div
                  role="menu"
                  className="absolute right-0 bottom-full mb-2 max-h-64 min-w-44 overflow-auto rounded-md border border-white/10 bg-zinc-900/95 py-1 shadow-xl backdrop-blur"
                >
                  {versions.map((v) => (
                    <SubtitleMenuItem
                      key={v.fileId}
                      label={v.label || v.resolution}
                      active={v.fileId === selectedFileId}
                      onSelect={() => {
                        setSelectedFileId(v.fileId);
                        setQualityOpen(false);
                        showControls();
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Subtitles (CC) — menu opens upward so it isn't clipped at the edge */}
          <div className="relative">
            <Button
              variant={selectedSub >= 0 ? "primary" : "ghost"}
              size="icon"
              onClick={() => {
                setCcOpen((o) => !o);
                setQualityOpen(false);
                showControls();
              }}
              aria-label="Subtitles"
              aria-haspopup="menu"
              aria-expanded={ccOpen}
            >
              <span className="text-xs font-bold tracking-tight">CC</span>
            </Button>
            {ccOpen && (
              <div
                role="menu"
                className="absolute right-0 bottom-full mb-2 max-h-64 min-w-44 overflow-auto rounded-md border border-white/10 bg-zinc-900/95 py-1 shadow-xl backdrop-blur"
              >
                <SubtitleMenuItem
                  label="Off"
                  active={selectedSub === -1}
                  onSelect={() => {
                    setSelectedSub(-1);
                    setCcOpen(false);
                    showControls();
                  }}
                />
                {tracks.length === 0 && (
                  <p className="px-3 py-2 text-xs text-zinc-500">No subtitles available</p>
                )}
                {tracks.map((t, i) => (
                  <SubtitleMenuItem
                    key={t.id}
                    label={t.label}
                    active={selectedSub === i}
                    onSelect={() => {
                      setSelectedSub(i);
                      setCcOpen(false);
                      showControls();
                    }}
                  />
                ))}

                {/* Subtitle-sync timing — nudge the delay earlier / later. */}
                {selectedSub >= 0 && (
                  <div className="mt-1 border-t border-white/10 px-3 pb-1 pt-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                        Timing
                      </span>
                      {subtitleOffset !== 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            resetOffset();
                            showControls();
                          }}
                          className="text-[11px] text-zinc-400 hover:text-zinc-200"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          nudgeOffset(-SUBTITLE_OFFSET_STEP);
                          showControls();
                        }}
                        aria-label="Subtitles earlier"
                        className="flex size-7 items-center justify-center rounded border border-white/15 text-base leading-none text-zinc-100 transition-colors hover:bg-white/10"
                      >
                        −
                      </button>
                      <span className="min-w-14 text-center text-xs font-medium tabular-nums text-zinc-100">
                        {formatOffset(subtitleOffset)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          nudgeOffset(SUBTITLE_OFFSET_STEP);
                          showControls();
                        }}
                        aria-label="Subtitles later"
                        className="flex size-7 items-center justify-center rounded border border-white/15 text-base leading-none text-zinc-100 transition-colors hover:bg-white/10"
                      >
                        +
                      </button>
                    </div>
                    <div className="mt-1.5 text-center text-[10px] text-zinc-500">
                      Shortcut: <kbd className="text-zinc-400">[</kbd> earlier ·{" "}
                      <kbd className="text-zinc-400">]</kbd> later
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Fullscreen toggle (opt-in; also bound to F) */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {isFullscreen ? (
                <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" />
              ) : (
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              )}
            </svg>
          </Button>
        </div>
      </div>
    </div>
  );

  return mounted ? createPortal(overlay, document.body) : null;
}

function SubtitleMenuItem({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/10",
        active ? "text-amber-400" : "text-zinc-200"
      )}
    >
      <span className="w-3 shrink-0 text-amber-400" aria-hidden="true">
        {active ? "✓" : ""}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Native direct play with a "Try transcoding" fallback on <video> error. */
function DirectPlayer({
  target,
  fileId,
  tracks,
  selectedSub,
  subtitleStyle,
  subtitleOffset,
  onFallback,
  onTime,
  onEnded,
}: {
  target: PlaybackTarget;
  fileId: number | null;
  tracks: SubtitleTrack[];
  selectedSub: number;
  subtitleStyle: SubtitleStyle;
  subtitleOffset: number;
  onFallback: () => void;
  onTime?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleSinkRef = useRef<HTMLDivElement>(null);
  const [errored, setErrored] = useState(false);

  useWatchProgress(videoRef, target);
  useStyledSubtitles(videoRef, tracks, selectedSub, subtitleOffset, subtitleSinkRef);

  // A specific version streams from `?file=<id>`; the primary/default omits it.
  const src = `/api/v1/stream/${target.type}/${target.id}${fileId != null ? `?file=${fileId}` : ""}`;

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        controls
        autoPlay
        className="h-full w-full bg-black object-contain"
        src={src}
        onError={() => setErrored(true)}
        onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime, e.currentTarget.duration)}
        onEnded={() => onEnded?.()}
      >
        <SubtitleTracks tracks={tracks} />
      </video>
      <SubtitleOverlay sinkRef={subtitleSinkRef} style={subtitleStyle} />
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

/**
 * Server-side HLS playback. On mount it POSTs to start a transcode session, then
 * attaches hls.js (or native HLS on Safari) to the `<video>`. On unmount it
 * destroys the hls.js instance and DELETEs the session so the server tears down
 * ffmpeg and reclaims disk.
 */
function TranscodePlayer({
  target,
  fileId,
  tracks,
  selectedSub,
  subtitleStyle,
  subtitleOffset,
  onTime,
  onEnded,
}: {
  target: PlaybackTarget;
  fileId: number | null;
  tracks: SubtitleTrack[];
  selectedSub: number;
  subtitleStyle: SubtitleStyle;
  subtitleOffset: number;
  onTime?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
}) {
  const { type, id } = target;
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleSinkRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"starting" | "playing" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useWatchProgress(videoRef, target);
  useStyledSubtitles(videoRef, tracks, selectedSub, subtitleOffset, subtitleSinkRef);

  useEffect(() => {
    let cancelled = false;
    let hls: HlsInstance | null = null;
    let sessionId: string | null = null;

    async function start() {
      try {
        const res = await apiFetch<{ sessionId: string; url: string }>("/transcode", {
          method: "POST",
          body: JSON.stringify({ type, id, ...(fileId != null ? { fileId } : {}) }),
        });
        sessionId = res.sessionId; // capture before any early return so cleanup can DELETE it
        if (cancelled) return;

        const video = videoRef.current;
        if (!video) return;

        const { default: Hls } = await import("hls.js");
        if (cancelled) return;

        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true });
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (data.fatal && !cancelled) {
              setStatus("error");
              setError(
                "The transcode stream failed. The file may be unsupported or ffmpeg errored."
              );
            }
          });
          hls.loadSource(res.url);
          hls.attachMedia(video);
          setStatus("playing");
          void video.play?.().catch(() => {});
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari / iOS play HLS natively.
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
        if (httpStatus === 503) {
          setError("Transcoding is unavailable — ffmpeg is not installed on the server.");
        } else if (httpStatus === 429) {
          setError("The server is at its transcoding capacity. Close another stream and retry.");
        } else {
          setError(err instanceof Error ? err.message : "Failed to start transcoding.");
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      hls?.destroy();
      if (sessionId) {
        // Raw fetch (204, no JSON body) with keepalive so it survives teardown.
        void fetch(`/api/v1/transcode/${sessionId}`, { method: "DELETE", keepalive: true }).catch(
          () => {}
        );
      }
    };
  }, [type, id, fileId]);

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        controls
        autoPlay
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
