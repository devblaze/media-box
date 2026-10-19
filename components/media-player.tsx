"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { apiFetch, useApi } from "@/lib/api";
import { cachedLinkKbps, measureLinkKbps } from "@/lib/bandwidth";
import { cn } from "@/lib/cn";
import {
  loadSubtitlePref,
  loadSubtitleStyle,
  matchSubtitlePref,
  saveSubtitlePref,
  type SubtitlePref,
  type SubtitleStyle,
} from "@/lib/subtitle-style";
import {
  DEFAULT_TRANSCODE_QUALITY,
  TRANSCODE_QUALITIES,
  formatKbps,
  linkCanCarry,
} from "@/lib/transcode-quality";
import { useEvents } from "@/lib/use-events";
import type { MediaInfo } from "@/server/library/media-info";
// Type-only: the runtime lives in a server module (node:events); erased at build.
import type { WatchCommand } from "@/server/events/bus";
import { Button, Spinner } from "@/components/ui";
import { PlayOnTvButton } from "@/components/play-on-tv-button";
import type { SubtitleTrack } from "@/components/subtitle-overlay";
import { DirectPlayer } from "@/components/player/direct-player";
import { TranscodePlayer } from "@/components/player/transcode-player";
import { SeekBar } from "@/components/player/seek-bar";
import {
  SubtitleMenu,
  SUBTITLE_OFFSET_STEP,
  useSubtitleSearch,
} from "@/components/player/subtitle-menu";
import { MenuHeading, MenuItem, MenuPanel, chipClass } from "@/components/player/menu";
import { useMediaState, useSeeker } from "@/components/player/media-hooks";
import { useStreamQuality, type StreamQuality } from "@/components/player/use-stream-quality";
import { useTitleData } from "@/components/player/use-title-data";
import { canDirectPlay } from "@/components/player/playback-support";
import { enterFullscreen, exitFullscreen, useIsFullscreen } from "@/components/player/fullscreen";
import {
  AUTO_QUALITY,
  loadForceTranscode,
  loadVolumePref,
  saveForceTranscode,
  saveVolumePref,
} from "@/components/player/preferences";
import {
  fmtClock,
  formatOffset,
  formatSkip,
  neighborLabel,
  qualityTagFromHeight,
} from "@/components/player/format";
import {
  AudioTrackIcon,
  BackIcon,
  FullscreenIcon,
  NextEpisodeIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  PrevEpisodeIcon,
  SkipIcon,
  SkipToIcon,
  SpeedIcon,
  VersionsIcon,
  VolumeIcon,
} from "@/components/player/icons";
import type { Neighbor, PlaybackMode, PlaybackTarget, WatchSync } from "@/components/player/types";

export { MediaInfoBadges } from "@/components/player/media-info-badges";
export type { PlaybackTarget, WatchSync } from "@/components/player/types";

/** How early (seconds before the end) the auto-advance "Up next" card appears. */
const UP_NEXT_LEAD_SECONDS = 25;
/** Seconds the "Up next" auto-advance countdown starts from. */
const UP_NEXT_COUNTDOWN = 10;
/** Seconds per skip: the ← / → keys, J / L, and the skip buttons. */
const SKIP_SECONDS = 10;
/** Seconds per Shift+← / Shift+→. */
const BIG_SKIP_SECONDS = 30;
/** Volume change (0–1) per ↑ / ↓ press. */
const VOLUME_STEP = 0.1;
/** Clamp the subtitle sync offset so it can never run away. */
const SUBTITLE_OFFSET_MAX = 60;
/** Idle time before the controls fade (they stay while paused or a menu is open). */
const CONTROLS_HIDE_MS = 3_000;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

type MenuId = "stream" | "versions" | "audio" | "subtitles" | "speed";

const noSubscription = () => () => {};
/** True once rendering on the client: the overlay portals to <body>, which SSR lacks. */
function useIsClient(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false
  );
}

function sameTarget(a: PlaybackTarget, b: PlaybackTarget): boolean {
  return a.type === b.type && a.id === b.id;
}

/** Controls that show on activity and fade after a quiet spell. */
function useAutoHide(ms: number) {
  const [visible, setVisible] = useState(true);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
  };
  const poke = useCallback(() => {
    setVisible(true);
    clear();
    timer.current = window.setTimeout(() => setVisible(false), ms);
  }, [ms]);
  const hide = useCallback(() => {
    clear();
    setVisible(false);
  }, []);
  useEffect(() => {
    timer.current = window.setTimeout(() => setVisible(false), ms);
    return clear;
  }, [ms]);
  return { visible, poke, hide };
}

type Controls = ReturnType<typeof useAutoHide>;

/**
 * Immersive, Netflix-style player. It plays a title either by DIRECT play (native
 * `<video>` on the gated stream route) or by TRANSCODE (server-side HLS via
 * ffmpeg, loaded with hls.js). The initial mode is chosen from {@link MediaInfo}
 * and the measured connection; a chip lets the viewer force transcoding, and a
 * failed direct play offers a one-click fallback.
 *
 * Presentation is a full-window black overlay that stays windowed — the browser
 * chrome remains visible. Native fullscreen is opt-in (button, `F`, or a double
 * click on the picture). The chrome auto-hides after a few seconds without the
 * mouse moving, except while paused or a menu is open.
 *
 * This shell holds what outlives one title — the episode being played, the
 * connection's stream size, the viewer's preferences, watch-together — and
 * renders a {@link TitlePlayback} keyed by title, so moving to another episode
 * resets everything about the last one simply by remounting.
 *
 * Mount it only while a title is selected so state resets between plays.
 */
export function VideoPlayerModal({
  target,
  title,
  mediaInfo,
  onClose,
  sync,
}: {
  target: PlaybackTarget;
  title: React.ReactNode;
  mediaInfo?: MediaInfo | null;
  onClose: () => void;
  sync?: WatchSync;
}) {
  const isClient = useIsClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const controls = useAutoHide(CONTROLS_HIDE_MS);
  const quality = useStreamQuality();

  // The title actually playing: the opened `target` at first, then whichever
  // episode prev/next, "Up next" or the watch-together host moved to.
  const [current, setCurrent] = useState<PlaybackTarget>(target);
  const [currentTitle, setCurrentTitle] = useState<React.ReactNode>(title);
  const navigate = useCallback((next: PlaybackTarget, label: React.ReactNode) => {
    setCurrent(next);
    setCurrentTitle(label);
  }, []);

  const [forceTranscode, setForceTranscode] = useState(loadForceTranscode);
  const [subtitleStyle] = useState<SubtitleStyle>(loadSubtitleStyle);
  // Remembered subtitle choice, auto-applied to each new title so the viewer
  // doesn't re-pick e.g. English on every episode.
  const [subPref, setSubPref] = useState<SubtitlePref | null>(loadSubtitlePref);
  const rememberSubtitle = useCallback((pref: SubtitlePref) => {
    setSubPref(pref);
    saveSubtitlePref(pref);
  }, []);

  // The live <video>, registered up from whichever child player is mounted.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const registerVideo = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
    setVideoEl(el);
  }, []);

  // Carry volume and speed onto every new element (a quality change, the next
  // episode), and remember volume for the next time the player opens.
  const rateRef = useRef(1);
  useEffect(() => {
    const el = videoElRef.current; // the element `videoEl` names, as a ref so it can be driven
    if (!el) return;
    const saved = loadVolumePref();
    el.volume = saved.volume;
    el.muted = saved.muted;
    // A new source resets playbackRate to defaultPlaybackRate, so set both.
    el.defaultPlaybackRate = rateRef.current;
    el.playbackRate = rateRef.current;
    const onVolume = () => saveVolumePref({ volume: el.volume, muted: el.muted });
    const onRate = () => {
      rateRef.current = el.playbackRate;
    };
    el.addEventListener("volumechange", onVolume);
    el.addEventListener("ratechange", onRate);
    return () => {
      el.removeEventListener("volumechange", onVolume);
      el.removeEventListener("ratechange", onRate);
    };
  }, [videoEl]);

  // ---- watch-together ----

  // Whether this player mirrors OUT (host) or IN (joiner). A joiner is explicit
  // (opened by the "Join" UI). Host mode is on when explicitly requested OR the
  // signed-in user shares their streaming activity — the /sync endpoint simply
  // no-ops server-side when nobody has joined, so this is cheap and automatic.
  const { data: me } = useApi<{ shareStreamingActivity?: boolean }>("/auth/me");
  const isJoiner = sync?.role === "joiner";
  const hostActive = !isJoiner && (sync?.role === "host" || !!me?.shareStreamingActivity);

  // HOST: mirror play / pause / seek out to joiners. Seeks are debounced on the
  // trailing edge, so joiners land where a scrub SETTLED, not somewhere on the way.
  useEffect(() => {
    if (!hostActive || !videoEl) return;
    let seekTimer: ReturnType<typeof setTimeout> | null = null;
    const onPlay = () => postSync({ kind: "play", positionSeconds: videoEl.currentTime });
    const onPause = () => postSync({ kind: "pause", positionSeconds: videoEl.currentTime });
    const onSeeked = () => {
      if (seekTimer) clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        postSync({ kind: "seek", positionSeconds: videoEl.currentTime });
      }, 300);
    };
    videoEl.addEventListener("play", onPlay);
    videoEl.addEventListener("pause", onPause);
    videoEl.addEventListener("seeked", onSeeked);
    return () => {
      if (seekTimer) clearTimeout(seekTimer);
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("seeked", onSeeked);
    };
  }, [hostActive, videoEl]);

  // HOST: when the title changes, tell joiners to follow. Not on the first run —
  // that's the title they already have.
  const firstTitleSync = useRef(true);
  useEffect(() => {
    if (!hostActive) return;
    if (firstTitleSync.current) {
      firstTitleSync.current = false;
      return;
    }
    postSync({ kind: "title", target: current, positionSeconds: 0 });
  }, [current, hostActive]);

  // JOINER: apply a command from the host. Joiners never attach the host's
  // transport listeners, so applying one can't echo back out.
  const onWatchEvent = useCallback(
    (e: { type: string; [key: string]: unknown }) => {
      if (!isJoiner || e.type !== "watch.sync" || !e.command) return;
      const command = e.command as WatchCommand;
      const v = videoElRef.current;
      const correct = () => {
        const t = command.positionSeconds;
        if (v && t != null && Math.abs(v.currentTime - t) > 2.5) v.currentTime = t;
      };
      switch (command.kind) {
        case "play":
          correct();
          void v?.play().catch(() => {});
          break;
        case "pause":
          correct();
          v?.pause();
          break;
        case "seek":
          if (v && command.positionSeconds != null) v.currentTime = command.positionSeconds;
          break;
        case "title":
          if (command.target) navigate(command.target, "Watching together");
          break;
      }
    },
    [isJoiner, navigate]
  );
  useEvents(onWatchEvent);

  const handleClose = useCallback(() => {
    exitFullscreen();
    onClose();
  }, [onClose]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) exitFullscreen();
    else enterFullscreen(containerRef.current);
  }, []);

  const isOpenedTitle = sameTarget(current, target);

  const overlay = (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black"
      onMouseMove={controls.poke}
      // The portal moves this to <body> in the DOM, but React still bubbles events
      // to the component that rendered the player (e.g. the card you clicked Play
      // on). Stop them here so a click inside the player never reaches that card.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TitlePlayback
        key={`${current.type}-${current.id}`}
        target={current}
        title={currentTitle}
        // Probed info describes the title the player was opened on, not its neighbours.
        mediaInfo={isOpenedTitle ? mediaInfo : null}
        startAt={isJoiner && isOpenedTitle ? sync.startPositionSeconds : undefined}
        isJoiner={isJoiner}
        forceTranscode={forceTranscode}
        onForceTranscode={(on) => {
          setForceTranscode(on);
          saveForceTranscode(on);
        }}
        quality={quality}
        subtitleStyle={subtitleStyle}
        subPref={subPref}
        onSubPref={rememberSubtitle}
        controls={controls}
        videoEl={videoEl}
        videoRef={videoElRef}
        onVideoEl={registerVideo}
        onNavigate={navigate}
        onClose={handleClose}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  );

  return isClient ? createPortal(overlay, document.body) : null;
}

function postSync(command: WatchCommand): void {
  void apiFetch("/watch-together/sync", {
    method: "POST",
    body: JSON.stringify({ command }),
  }).catch(() => {});
}

/**
 * One title's playback: choosing direct play or a transcode (and at what size),
 * the picture, and the controls. Everything in here belongs to this title and is
 * thrown away with it.
 */
function TitlePlayback({
  target,
  title,
  mediaInfo,
  startAt,
  isJoiner,
  forceTranscode,
  onForceTranscode,
  quality,
  subtitleStyle,
  subPref,
  onSubPref,
  controls,
  videoEl,
  videoRef,
  onVideoEl,
  onNavigate,
  onClose,
  onToggleFullscreen,
}: {
  target: PlaybackTarget;
  title: React.ReactNode;
  mediaInfo: MediaInfo | null | undefined;
  /** A watch-together joiner's starting point (the host's position at join). */
  startAt: number | undefined;
  isJoiner: boolean;
  forceTranscode: boolean;
  onForceTranscode: (on: boolean) => void;
  quality: StreamQuality;
  subtitleStyle: SubtitleStyle;
  subPref: SubtitlePref | null;
  onSubPref: (pref: SubtitlePref) => void;
  controls: Controls;
  /** The live element, to subscribe to (changes re-render)… */
  videoEl: HTMLVideoElement | null;
  /** …and the same element, to drive from event handlers. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onVideoEl: (el: HTMLVideoElement | null) => void;
  onNavigate: (next: PlaybackTarget, label: React.ReactNode) => void;
  onClose: () => void;
  onToggleFullscreen: () => void;
}) {
  const data = useTitleData(target);
  const media = useMediaState(videoEl);
  const { seeker, burst } = useSeeker(videoEl);
  const isFullscreen = useIsFullscreen();
  const { poke } = controls;
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);

  // ---- what to play ----

  const [mode, setMode] = useState<PlaybackMode>(() =>
    forceTranscode || !canDirectPlay(mediaInfo) ? "transcode" : "direct"
  );
  // Set once the viewer picks a mode themselves: their choice then sticks, and the
  // bandwidth check stops overriding it.
  const [modeChosenByUser, setModeChosenByUser] = useState(false);
  // Direct play stalled for good and handed over to the transcoder.
  const [directGaveUp, setDirectGaveUp] = useState(false);
  // Where a re-created stream picks up (a new rung, version, audio track or mode).
  const [restartAt, setRestartAt] = useState<number | null>(startAt ?? null);
  // A version or audio track the viewer picked. Null = the server's default (the
  // primary file, its default track) — deliberately NOT the primary's id once the
  // version list arrives: the same file under a new key would rebuild the stream.
  const [fileChoice, setFileChoice] = useState<number | null>(null);
  const [audioChoice, setAudioChoice] = useState<number | null>(null);

  // Latest whole-second position, for restarting a stream where it left off.
  const playedSecondsRef = useRef(0);
  const resumeHere = useCallback(() => {
    setRestartAt(playedSecondsRef.current > 0 ? playedSecondsRef.current : null);
  }, []);

  const primary = data.versions.find((v) => v.isPrimary) ?? data.versions[0];
  const playingVersion = data.versions.find((v) => v.fileId === fileChoice) ?? primary;

  // Measure the link against the very file about to play, once per title, unless
  // this tab measured recently. It runs ALONGSIDE playback rather than gating it:
  // a healthy connection finishes in well under a second and notices nothing.
  // Once a transcode is running, its own segment timings take over.
  const { measure, stepDown, choose } = quality;
  useEffect(() => {
    if (cachedLinkKbps() != null) return;
    let cancelled = false;
    const url = `/api/v1/stream/${target.type}/${target.id}${fileChoice != null ? `?file=${fileChoice}` : ""}`;
    void measureLinkKbps(url).then((kbps) => {
      if (!cancelled && kbps != null && measure(kbps)) resumeHere();
    });
    return () => {
      cancelled = true;
    };
  }, [target.type, target.id, fileChoice, measure, resumeHere]);

  // The direct-play file's bitrate, kbps: from the version list when it has
  // resolved, else the probed info.
  const sourceKbps =
    playingVersion?.durationSec && playingVersion.size > 0
      ? (playingVersion.size * 8) / playingVersion.durationSec / 1000
      : mediaInfo?.bitrate
        ? mediaInfo.bitrate / 1000
        : null;
  // A weak connection is the one failure direct play cannot report: the browser
  // waits for bytes that arrive slower than they're consumed and buffers forever.
  // So when the measured link can't carry the file's bitrate, play a transcode
  // sized for the link instead. Derived, so it applies on the render it's known.
  const linkBlocksDirect =
    !modeChosenByUser && sourceKbps != null && !linkCanCarry(sourceKbps, quality.linkKbps);
  const effectiveMode: PlaybackMode = mode === "direct" && linkBlocksDirect ? "transcode" : mode;
  const reducedForLink =
    linkBlocksDirect ||
    directGaveUp ||
    (quality.isAuto && quality.autoQuality.id !== DEFAULT_TRANSCODE_QUALITY.id);

  const stepDownQuality = useCallback(() => {
    const moved = stepDown();
    if (moved) resumeHere();
    return moved;
  }, [stepDown, resumeHere]);
  const onLinkKbps = useCallback(
    (kbps: number) => {
      if (measure(kbps)) resumeHere();
    },
    [measure, resumeHere]
  );

  // ---- position, the end, and what comes next ----

  const [playedSeconds, setPlayedSeconds] = useState(0);
  const [elementDurationSec, setElementDurationSec] = useState(0);
  const [upNextVisible, setUpNextVisible] = useState(false);
  const [upNextCancelled, setUpNextCancelled] = useState(false);
  const [countdown, setCountdown] = useState(UP_NEXT_COUNTDOWN);
  const next = data.nextEpisode;
  const prev = data.prevEpisode;

  // Authoritative runtime: a live transcode's <video>.duration only covers what's
  // been encoded so far, so the seek bar and end-detection use the probed one.
  const realDurationSec = (playingVersion?.durationSec ?? mediaInfo?.durationSec) || 0;
  const durationSec = realDurationSec > 0 ? realDurationSec : elementDurationSec;

  const goTo = useCallback(
    (n: Neighbor) => onNavigate({ type: "episode", id: n.id }, neighborLabel(n)),
    [onNavigate]
  );

  const handleTime = useCallback(
    (currentTime: number, duration: number) => {
      const sec = Math.floor(currentTime);
      playedSecondsRef.current = sec;
      setPlayedSeconds(sec);
      if (Number.isFinite(duration) && duration > 0) setElementDurationSec(Math.floor(duration));
      // Only the PROBED duration: a live transcode's own starts tiny, and the card
      // would fire at once and skip to the next episode.
      if (next && !upNextCancelled && realDurationSec > 0) {
        if (currentTime >= realDurationSec - UP_NEXT_LEAD_SECONDS) setUpNextVisible(true);
      }
    },
    [next, upNextCancelled, realDurationSec]
  );

  // Ignore a premature 'ended' from a live transcode stalling at its encoded edge.
  const handleEnded = useCallback(() => {
    if (realDurationSec > 0 && playedSecondsRef.current < realDurationSec - 15) return;
    if (next && !upNextCancelled) goTo(next);
  }, [next, upNextCancelled, goTo, realDurationSec]);

  useEffect(() => {
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
  }, [upNextVisible, next, goTo]);

  const activeSkip =
    data.skipSegments.find(
      (s) => playedSeconds >= s.startSeconds && playedSeconds < s.endSeconds
    ) ?? null;

  // ---- subtitles ----

  const [subChoice, setSubChoice] = useState<number | null>(null);
  // Until the viewer picks, follow their remembered preference.
  const selectedSub = subChoice ?? matchSubtitlePref(data.tracks, subPref);
  const chooseSubtitle = useCallback(
    (index: number, tracks: SubtitleTrack[] = data.tracks) => {
      setSubChoice(index);
      const track = tracks[index];
      onSubPref(track ? { off: false, lang: track.language, kind: track.kind } : { off: true });
    },
    [data.tracks, onSubPref]
  );
  const subtitleSearch = useSubtitleSearch(
    target,
    data.subtitleLanguages,
    data.reloadSubtitles,
    (tracks, index) => {
      chooseSubtitle(index, tracks);
      setOpenMenu(null);
    }
  );

  // Sync offset (+ = later), nudged with [ / ] or the CC menu; a brief OSD confirms.
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  const [offsetOsd, setOffsetOsd] = useState(false);
  const osdTimer = useRef<number | null>(null);
  const flashOffset = useCallback(() => {
    setOffsetOsd(true);
    if (osdTimer.current) window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOffsetOsd(false), 1200);
  }, []);
  useEffect(
    () => () => {
      if (osdTimer.current) window.clearTimeout(osdTimer.current);
    },
    []
  );
  const nudgeOffset = useCallback(
    (delta: number) => {
      setSubtitleOffset((o) => {
        const clamped = Math.min(SUBTITLE_OFFSET_MAX, Math.max(-SUBTITLE_OFFSET_MAX, o + delta));
        return Math.round(clamped * 10) / 10; // one decimal, no float drift
      });
      flashOffset();
    },
    [flashOffset]
  );

  // ---- menus ----

  const toggleMenu = (id: MenuId) => {
    setOpenMenu((m) => (m === id ? null : id));
    poke();
  };
  const barVisible = controls.visible || openMenu != null || media.paused;

  const chooseQuality = (id: string) => {
    choose(id);
    setOpenMenu(null);
    resumeHere();
    if (id === AUTO_QUALITY) {
      // Back to the normal decision: direct play unless the link or codecs rule it out.
      setDirectGaveUp(false);
      setModeChosenByUser(false);
      setMode(forceTranscode || !canDirectPlay(mediaInfo) ? "transcode" : "direct");
    } else {
      // Naming a rung means "encode it at this size", which only a transcode does.
      setModeChosenByUser(true);
      setMode("transcode");
    }
  };

  const toggleForceTranscode = () => {
    const on = !forceTranscode;
    onForceTranscode(on);
    // An explicit choice wins from here on: the bandwidth check stops moving the
    // viewer off the mode they asked for.
    setModeChosenByUser(true);
    setDirectGaveUp(false);
    resumeHere();
    setMode(on || !canDirectPlay(mediaInfo) ? "transcode" : "direct");
    poke();
  };

  // ---- transport ----

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
    poke();
  }, [videoRef, poke]);

  const seekBy = useCallback(
    (delta: number) => {
      seeker.seekBy(delta);
      poke();
    },
    [seeker, poke]
  );

  const seekTo = useCallback(
    (t: number) => {
      seeker.seekTo(t);
      poke();
    },
    [seeker, poke]
  );

  /** Set the volume; turning it up (or dragging the slider) also unmutes. */
  const setVolume = useCallback(
    (volume: number, unmute = true) => {
      const el = videoRef.current;
      if (!el) return;
      const v = Math.max(0, Math.min(1, Math.round(volume * 100) / 100));
      el.volume = v;
      el.muted = v === 0 || (!unmute && el.muted);
      poke();
    },
    [videoRef, poke]
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    // Unmuting at zero would stay silent.
    if (!v.muted && v.volume === 0) v.volume = 0.5;
    poke();
  }, [videoRef, poke]);

  const setRate = useCallback(
    (rate: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.defaultPlaybackRate = rate;
      v.playbackRate = rate;
      poke();
    },
    [videoRef, poke]
  );

  // Taps and clicks on the picture. A mouse click toggles play and a double click
  // fullscreen, as on every desktop player; a tap shows or hides the controls,
  // since a finger can't hover to reveal them.
  const pointerType = useRef("mouse");
  const onPictureClick = (e: React.MouseEvent) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    if (pointerType.current === "touch") {
      if (controls.visible) controls.hide();
      else poke();
      return;
    }
    togglePlay();
  };
  const onPictureDoubleClick = (e: React.MouseEvent) => {
    if (e.target instanceof HTMLVideoElement && pointerType.current !== "touch")
      onToggleFullscreen();
  };

  // ---- keyboard ----
  //
  // Esc is layered so it never closes the player by surprise: an open menu closes
  // first, then fullscreen exits, and only a bare Esc closes the player.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack typing or modified shortcuts.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      const handled = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const step = e.shiftKey ? BIG_SKIP_SECONDS : SKIP_SECONDS;
      switch (key) {
        case "Escape":
          if (openMenu) setOpenMenu(null);
          else if (document.fullscreenElement) exitFullscreen();
          else onClose();
          return;
        case " ":
        case "k":
          return handled(togglePlay);
        case "ArrowLeft":
        case "j":
          return handled(() => seekBy(-step));
        case "ArrowRight":
        case "l":
          return handled(() => seekBy(step));
        case "Home":
          return handled(() => seekTo(0));
        case "End":
          return handled(() => durationSec > 0 && seekTo(durationSec - 1));
        case "ArrowUp":
          return handled(() => setVolume((media.muted ? 0 : media.volume) + VOLUME_STEP));
        case "ArrowDown":
          return handled(() => setVolume(media.volume - VOLUME_STEP, false));
        case "m":
          return handled(toggleMute);
        case "f":
          return handled(onToggleFullscreen);
        case "c":
          return handled(() => {
            // Toggle captions: off, or back to the remembered language (else the first).
            if (selectedSub >= 0) chooseSubtitle(-1);
            else if (data.tracks.length > 0) {
              const preferred =
                subPref && !subPref.off ? matchSubtitlePref(data.tracks, subPref) : -1;
              chooseSubtitle(preferred >= 0 ? preferred : 0);
            }
            poke();
          });
        case "<":
        case ">": {
          const i = PLAYBACK_RATES.indexOf(media.playbackRate);
          const at = i < 0 ? PLAYBACK_RATES.indexOf(1) : i;
          const nextRate =
            PLAYBACK_RATES[
              Math.max(0, Math.min(PLAYBACK_RATES.length - 1, at + (key === ">" ? 1 : -1)))
            ];
          return handled(() => setRate(nextRate));
        }
        case "[":
        case "]":
          if (selectedSub < 0) return;
          return handled(() =>
            nudgeOffset(key === "[" ? -SUBTITLE_OFFSET_STEP : SUBTITLE_OFFSET_STEP)
          );
        case "n":
          if (e.shiftKey && next) handled(() => goTo(next));
          return;
        case "p":
          if (e.shiftKey && prev) handled(() => goTo(prev));
          return;
      }
      // 0–9 jump to that tenth of the runtime, as on YouTube.
      if (/^[0-9]$/.test(key) && durationSec > 0)
        handled(() => seekTo((Number(key) / 10) * durationSec));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    openMenu,
    onClose,
    togglePlay,
    seekBy,
    seekTo,
    durationSec,
    setVolume,
    toggleMute,
    onToggleFullscreen,
    selectedSub,
    chooseSubtitle,
    data.tracks,
    subPref,
    media.playbackRate,
    media.muted,
    media.volume,
    setRate,
    nudgeOffset,
    next,
    prev,
    goTo,
    poke,
  ]);

  // ---- chips ----

  const qualityChip = playingVersion?.resolution ?? qualityTagFromHeight(mediaInfo?.video?.height);
  const shownTime = burst?.pending ? burst.target : playedSeconds;
  const canPip =
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled &&
    !!videoEl?.requestPictureInPicture;

  const playerProps = {
    target,
    tracks: data.tracks,
    selectedSub,
    subtitleStyle,
    subtitleOffset,
    onTime: handleTime,
    onEnded: handleEnded,
    onVideoEl,
    disableProgress: isJoiner,
  };

  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center",
        !barVisible && "cursor-none"
      )}
      onPointerDown={(e) => {
        pointerType.current = e.pointerType;
      }}
      onClick={onPictureClick}
      onDoubleClick={onPictureDoubleClick}
    >
      {effectiveMode === "direct" ? (
        <DirectPlayer
          key={`direct-${fileChoice ?? "default"}`}
          {...playerProps}
          fileId={fileChoice}
          startAt={restartAt}
          onFallback={() => {
            resumeHere();
            setMode("transcode");
          }}
          onTooSlow={() => {
            // The file arrives slower than it plays and the browser will never say
            // so: hand over to a transcode sized for the link, from where it got to.
            resumeHere();
            setDirectGaveUp(true);
            setMode("transcode");
          }}
        />
      ) : (
        <TranscodePlayer
          key={`hls-${fileChoice ?? "default"}-a${audioChoice ?? "def"}-q${quality.active.id}`}
          {...playerProps}
          fileId={fileChoice}
          audioTrack={audioChoice}
          initialStartSec={restartAt ?? (isJoiner ? 0 : undefined)}
          quality={quality.active}
          onTooSlow={stepDownQuality}
          onLinkKbps={onLinkKbps}
          slowHint={
            quality.isAuto
              ? "This is already the smallest stream the server makes."
              : "Stream quality is pinned — switch it to Auto and it will find a size that fits."
          }
        />
      )}

      {media.buffering && (
        <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
          <Spinner className="size-10 text-zinc-200" />
        </div>
      )}

      {/* Running total of a burst of skips, and where it lands. */}
      {burst?.relative && Math.abs(burst.delta) >= 1 && (
        <div className="pointer-events-none absolute inset-x-0 top-1/4 z-20 flex justify-center">
          <div className="flex items-baseline gap-2 rounded-lg bg-black/70 px-4 py-2 text-white shadow-lg backdrop-blur">
            <span className="text-lg font-semibold tabular-nums">{formatSkip(burst.delta)}</span>
            <span className="text-sm text-zinc-300 tabular-nums">{fmtClock(burst.target)}</span>
          </div>
        </div>
      )}

      {offsetOsd && (
        <div className="pointer-events-none absolute inset-x-0 top-1/4 z-20 flex justify-center">
          <div className="rounded-lg bg-black/70 px-4 py-2 text-sm font-medium text-white shadow-lg backdrop-blur">
            Subtitle delay {formatOffset(subtitleOffset)}
          </div>
        </div>
      )}

      {/* Skip Intro / Skip Recap — shown while inside one, even with the controls hidden. */}
      {activeSkip && !upNextVisible && (
        <button
          type="button"
          onClick={() => seekTo(activeSkip.endSeconds)}
          className="pointer-events-auto absolute right-4 bottom-28 z-20 flex items-center gap-2 rounded-md border border-white/20 bg-black/70 px-4 py-2 text-sm font-semibold text-white shadow-lg backdrop-blur transition-colors hover:bg-black/90"
        >
          <SkipToIcon className="size-4" />
          {activeSkip.label}
        </button>
      )}

      {/* Auto-advance "Up next" card, above the control bar, in the final stretch. */}
      {upNextVisible && next && (
        <div className="pointer-events-auto absolute right-3 bottom-28 z-20 w-72 max-w-[calc(100%-1.5rem)] rounded-lg border border-white/10 bg-zinc-900/95 p-4 shadow-xl backdrop-blur sm:right-4">
          <p className="text-[11px] font-medium tracking-wide text-zinc-400 uppercase">Up next</p>
          <p className="mt-1 line-clamp-2 text-sm font-semibold text-white">
            {neighborLabel(next)}
          </p>
          <p className="mt-2 text-xs text-zinc-400" aria-live="polite">
            Playing in {Math.max(0, countdown)}s…
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => goTo(next)}>
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

      {/* Top: Back + title. */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-3 py-3 pb-10 transition-opacity duration-300 sm:gap-3 sm:px-4",
          barVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 font-semibold text-white outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-amber-500/50"
        >
          <BackIcon className="size-7 sm:size-8" />
          <span className="text-base sm:text-lg">Back</span>
        </button>
        <div className="min-w-0 flex-1 truncate text-base font-semibold text-white sm:text-lg">
          {title}
        </div>
      </div>

      {/* The control bar: scrubber on top, transport on the left, settings on the right. */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300",
          barVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

        <div className="relative flex flex-col gap-1 px-3 pb-2 sm:px-4">
          <div className="flex items-center gap-3">
            <SeekBar
              video={videoEl}
              duration={durationSec}
              pendingTime={burst?.pending ? burst.target : null}
              markers={data.skipSegments}
              onSeek={seekTo}
              onActivity={poke}
            />
            <span className="shrink-0 text-xs whitespace-nowrap text-zinc-300 tabular-nums">
              {fmtClock(shownTime)}
              {durationSec > 0 ? ` / ${fmtClock(durationSec)}` : ""}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={togglePlay}
              aria-label={media.paused ? "Play" : "Pause"}
            >
              {media.paused ? <PlayIcon /> : <PauseIcon />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => seekBy(-SKIP_SECONDS)}
              aria-label={`Back ${SKIP_SECONDS} seconds`}
              title={`Back ${SKIP_SECONDS}s (←, J)`}
            >
              <SkipIcon seconds={SKIP_SECONDS} forward={false} className="size-6" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => seekBy(SKIP_SECONDS)}
              aria-label={`Forward ${SKIP_SECONDS} seconds`}
              title={`Forward ${SKIP_SECONDS}s (→, L)`}
            >
              <SkipIcon seconds={SKIP_SECONDS} forward className="size-6" />
            </Button>

            {target.type === "episode" && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!prev}
                  onClick={() => prev && goTo(prev)}
                  aria-label="Previous episode"
                  title="Previous episode (Shift+P)"
                >
                  <PrevEpisodeIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!next}
                  onClick={() => next && goTo(next)}
                  aria-label="Next episode"
                  title="Next episode (Shift+N)"
                >
                  <NextEpisodeIcon />
                </Button>
              </>
            )}

            <div className="group/volume flex items-center">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleMute}
                aria-label={media.muted ? "Unmute" : "Mute"}
              >
                <VolumeIcon muted={media.muted} level={media.volume} />
              </Button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={media.muted ? 0 : media.volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label="Volume"
                className="hidden h-1 w-20 cursor-pointer accent-amber-500 sm:block"
              />
            </div>

            <div className="min-w-0 flex-1" />

            {/* Mode chip: a toggle that forces transcoding, the fix for a file that
                plays silent here (audio this device can't decode). Remembered. */}
            <button
              type="button"
              onClick={toggleForceTranscode}
              aria-pressed={forceTranscode}
              title={
                forceTranscode
                  ? "Transcoding is forced (fixes no-audio / incompatible files). Tap to go back to automatic."
                  : effectiveMode === "transcode"
                    ? "This file is transcoded automatically for this device. Tap to always transcode."
                    : "Playing directly. No sound or won't play? Tap to transcode — re-encodes audio to compatible stereo AAC."
              }
              className={chipClass(forceTranscode)}
            >
              {effectiveMode === "transcode" ? "Transcoding" : "Direct"}
            </button>

            {/* Stream quality: the control for a weak link to the server. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => toggleMenu("stream")}
                aria-haspopup="menu"
                aria-expanded={openMenu === "stream"}
                title={
                  quality.isAuto
                    ? quality.linkKbps != null
                      ? `Stream quality: automatic. Your connection to the server measures ${formatKbps(quality.linkKbps)}.`
                      : "Stream quality: automatic."
                    : `Stream quality fixed at ${quality.active.label}.`
                }
                className={chipClass(reducedForLink)}
              >
                {!quality.isAuto
                  ? quality.active.label
                  : effectiveMode === "transcode"
                    ? `Auto · ${quality.active.height}p`
                    : "Auto"}
              </button>
              {openMenu === "stream" && (
                <MenuPanel className="min-w-56">
                  <MenuHeading>Stream quality</MenuHeading>
                  <MenuItem
                    label={
                      quality.linkKbps != null
                        ? `Auto · connection ${formatKbps(quality.linkKbps)}`
                        : "Auto · match my connection"
                    }
                    active={quality.isAuto}
                    onSelect={() => chooseQuality(AUTO_QUALITY)}
                  />
                  {TRANSCODE_QUALITIES.map((q) => (
                    <MenuItem
                      key={q.id}
                      label={q.label}
                      active={quality.pref === q.id}
                      onSelect={() => chooseQuality(q.id)}
                    />
                  ))}
                  {reducedForLink && quality.isAuto && (
                    <p className="px-3 py-1 text-[11px] text-amber-400/90">
                      Reduced to {quality.active.label} — the connection to the server could not
                      carry more.
                    </p>
                  )}
                </MenuPanel>
              )}
            </div>

            {qualityChip && (
              <span
                className="rounded-md border border-white/15 px-2 py-1 text-xs font-medium text-zinc-200"
                aria-label={`Current quality ${qualityChip}`}
              >
                {qualityChip}
              </span>
            )}

            {/* File version picker — only when there's more than one. */}
            {data.versions.length > 1 && (
              <div className="relative">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => toggleMenu("versions")}
                  aria-label="Quality"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "versions"}
                >
                  <VersionsIcon />
                </Button>
                {openMenu === "versions" && (
                  <MenuPanel>
                    {data.versions.map((v) => (
                      <MenuItem
                        key={v.fileId}
                        label={v.label || v.resolution}
                        active={v.fileId === playingVersion?.fileId}
                        onSelect={() => {
                          setOpenMenu(null);
                          if (v.fileId === playingVersion?.fileId) return;
                          resumeHere();
                          setFileChoice(v.isPrimary ? null : v.fileId);
                        }}
                      />
                    ))}
                  </MenuPanel>
                )}
              </div>
            )}

            {/* Audio-track picker — only for multi-audio files. Choosing one
                transcodes that stream, fixing a silent or wrong default track. */}
            {data.audioTracks.length > 1 && (
              <div className="relative">
                <Button
                  variant={audioChoice != null ? "primary" : "ghost"}
                  size="icon"
                  onClick={() => toggleMenu("audio")}
                  aria-label="Audio track"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "audio"}
                  title="Audio track"
                >
                  <AudioTrackIcon />
                </Button>
                {openMenu === "audio" && (
                  <MenuPanel className="min-w-52">
                    <MenuHeading>Audio</MenuHeading>
                    {data.audioTracks.map((t) => (
                      <MenuItem
                        key={t.index}
                        label={t.isDefault ? `${t.label} · default` : t.label}
                        active={audioChoice === t.index || (audioChoice == null && t.isDefault)}
                        onSelect={() => {
                          setOpenMenu(null);
                          resumeHere();
                          setAudioChoice(t.index);
                          setMode("transcode"); // remapping audio needs a transcode
                        }}
                      />
                    ))}
                  </MenuPanel>
                )}
              </div>
            )}

            {/* Playback speed. */}
            <div className="relative">
              <Button
                variant={media.playbackRate !== 1 ? "primary" : "ghost"}
                size="icon"
                onClick={() => toggleMenu("speed")}
                aria-label="Playback speed"
                aria-haspopup="menu"
                aria-expanded={openMenu === "speed"}
                title="Playback speed (< / >)"
              >
                <SpeedIcon />
              </Button>
              {openMenu === "speed" && (
                <MenuPanel className="min-w-32">
                  <MenuHeading>Speed</MenuHeading>
                  {PLAYBACK_RATES.map((r) => (
                    <MenuItem
                      key={r}
                      label={r === 1 ? "Normal" : `${r}×`}
                      active={media.playbackRate === r}
                      onSelect={() => {
                        setRate(r);
                        setOpenMenu(null);
                      }}
                    />
                  ))}
                </MenuPanel>
              )}
            </div>

            {/* Subtitles (CC) */}
            <div className="relative">
              <Button
                variant={selectedSub >= 0 ? "primary" : "ghost"}
                size="icon"
                onClick={() => toggleMenu("subtitles")}
                aria-label="Subtitles"
                aria-haspopup="menu"
                aria-expanded={openMenu === "subtitles"}
                title="Subtitles (C)"
              >
                <span className="text-xs font-bold tracking-tight">CC</span>
              </Button>
              {openMenu === "subtitles" && (
                <SubtitleMenu
                  tracks={data.tracks}
                  selected={selectedSub}
                  onSelect={(i) => {
                    chooseSubtitle(i);
                    setOpenMenu(null);
                    poke();
                  }}
                  canSearch={data.canSearchSubtitles}
                  search={subtitleSearch}
                  offset={subtitleOffset}
                  onNudge={(d) => {
                    nudgeOffset(d);
                    poke();
                  }}
                  onResetOffset={() => {
                    setSubtitleOffset(0);
                    flashOffset();
                    poke();
                  }}
                />
              )}
            </div>

            <PlayOnTvButton type={target.type} id={target.id} />

            {canPip && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (document.pictureInPictureElement)
                    void document.exitPictureInPicture().catch(() => {});
                  else void videoRef.current?.requestPictureInPicture().catch(() => {});
                }}
                aria-label="Picture in picture"
                title="Picture in picture"
              >
                <PipIcon />
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                onToggleFullscreen();
                poke();
              }}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title="Fullscreen (F)"
            >
              <FullscreenIcon active={isFullscreen} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
