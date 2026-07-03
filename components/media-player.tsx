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

const DIRECT_CONTAINERS = new Set(["mp4", "m4v", "mov"]);
const DIRECT_VIDEO = new Set(["h264", "avc", "avc1"]);
const DIRECT_AUDIO = new Set(["aac"]);

/**
 * Decide whether a file can be handed to a native `<video>` element as-is.
 * True only for MP4/H.264/AAC — the near-universal browser baseline. (ffprobe
 * reports MP4's container as "mov", so we accept that alias too.) When we have no
 * MediaInfo we optimistically default to direct play with a transcode fallback.
 */
function canDirectPlay(info: MediaInfo | null | undefined): boolean {
  if (!info) return true;
  const container = info.container.toLowerCase();
  const vcodec = info.video?.codec.toLowerCase() ?? "";
  const acodec = info.audio?.codec.toLowerCase() ?? "";
  return DIRECT_CONTAINERS.has(container) && DIRECT_VIDEO.has(vcodec) && DIRECT_AUDIO.has(acodec);
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

/**
 * Drives the `<video>`'s TextTrack modes from the selected subtitle index
 * (`-1` = off) and pipes the active cue text into a styled overlay element
 * (`sinkRef`). The selected track is set to `hidden` — the browser still parses
 * its cues (so `activeCues` is populated) but does NOT paint them, leaving our
 * own overlay as the sole, fully user-styleable renderer. Re-applies on
 * `loadedmetadata` because some browsers reset track modes on media load.
 */
function useStyledSubtitles(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  tracks: SubtitleTrack[],
  selectedIndex: number,
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

    // Push the currently-active cue text into the overlay imperatively (no React
    // state) so a caption change never re-renders the whole player.
    const render = () => {
      const sink = sinkRef.current;
      if (!sink) return;
      const cues = currentTrack()?.activeCues;
      if (!cues || cues.length === 0) {
        sink.textContent = "";
        sink.style.visibility = "hidden";
        return;
      }
      const parts: string[] = [];
      for (let i = 0; i < cues.length; i++) {
        parts.push(stripCueTags((cues[i] as VTTCue).text));
      }
      sink.textContent = parts.join("\n");
      sink.style.visibility = "visible";
    };

    setModes();
    render();

    const track = currentTrack();
    track?.addEventListener("cuechange", render);
    video.addEventListener("loadedmetadata", setModes);
    return () => {
      track?.removeEventListener("cuechange", render);
      video.removeEventListener("loadedmetadata", setModes);
    };
  }, [videoRef, tracks, selectedIndex, sinkRef]);
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
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [ccOpen, setCcOpen] = useState(false);
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [selectedSub, setSelectedSub] = useState(-1); // -1 = off (default)
  // The viewer's saved caption appearance, read once when the player opens.
  const [subtitleStyle] = useState<SubtitleStyle>(() => loadSubtitleStyle());

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

  // Fetch available subtitle tracks once on open (silent on failure).
  useEffect(() => {
    const key = target.type === "movie" ? "movieId" : "episodeId";
    let active = true;
    void apiFetch<{ tracks: SubtitleTrack[] }>(`/subtitles?${key}=${target.id}`)
      .then((res) => {
        if (active) setTracks(res.tracks ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [target.type, target.id]);

  // Fetch the available file versions once on open. Silent on failure — we then
  // treat the title as a single default version (no picker, fileId stays null).
  useEffect(() => {
    const type = target.type === "movie" ? "movie" : "episode";
    let active = true;
    void apiFetch<{ versions: MediaVersion[] }>(`/versions?type=${type}&id=${target.id}`)
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
  }, [target.type, target.id]);

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

  // F toggles fullscreen; Esc exits fullscreen first, otherwise closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "Escape") {
        if (document.fullscreenElement) exitFullscreen();
        else handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen, handleClose]);

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
    >
      {/* Keying by the selected fileId remounts the player when the version
          changes, which re-inits the source (and, via the shared hooks, saves the
          old position then resumes it on the newly-loaded stream). */}
      {mode === "direct" ? (
        <DirectPlayer
          key={selectedFileId ?? "default"}
          target={target}
          fileId={selectedFileId}
          tracks={tracks}
          selectedSub={selectedSub}
          subtitleStyle={subtitleStyle}
          onFallback={() => setMode("transcode")}
        />
      ) : (
        <TranscodePlayer
          key={selectedFileId ?? "default"}
          target={target}
          fileId={selectedFileId}
          tracks={tracks}
          selectedSub={selectedSub}
          subtitleStyle={subtitleStyle}
        />
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
          {title}
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
          {/* Direct / Transcode toggle */}
          <div className="flex items-center overflow-hidden rounded-md border border-white/15">
            <button
              type="button"
              onClick={() => {
                setMode("direct");
                showControls();
              }}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                mode === "direct"
                  ? "bg-amber-500 text-zinc-950"
                  : "text-zinc-200 hover:bg-white/10"
              )}
            >
              Direct
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("transcode");
                showControls();
              }}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                mode === "transcode"
                  ? "bg-amber-500 text-zinc-950"
                  : "text-zinc-200 hover:bg-white/10"
              )}
            >
              Transcode
            </button>
          </div>

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
  onFallback,
}: {
  target: PlaybackTarget;
  fileId: number | null;
  tracks: SubtitleTrack[];
  selectedSub: number;
  subtitleStyle: SubtitleStyle;
  onFallback: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleSinkRef = useRef<HTMLDivElement>(null);
  const [errored, setErrored] = useState(false);

  useWatchProgress(videoRef, target);
  useStyledSubtitles(videoRef, tracks, selectedSub, subtitleSinkRef);

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
}: {
  target: PlaybackTarget;
  fileId: number | null;
  tracks: SubtitleTrack[];
  selectedSub: number;
  subtitleStyle: SubtitleStyle;
}) {
  const { type, id } = target;
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleSinkRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"starting" | "playing" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useWatchProgress(videoRef, target);
  useStyledSubtitles(videoRef, tracks, selectedSub, subtitleSinkRef);

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
      <video ref={videoRef} controls autoPlay className="h-full w-full bg-black object-contain">
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
