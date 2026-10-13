import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import {
  getCastToken,
  getVersions,
  getWatchProgress,
  saveWatchProgress,
  startTranscode,
  stopTranscode,
  streamUrl,
  transcodePlaylistUrl,
  type PlayableType,
} from "@/lib/api";
import { theme } from "@/lib/theme";

const PROGRESS_SAVE_STEP_S = 15; // persist the playhead at most this often
const CONTROLS_HIDE_MS = 3500;
/** Skip steps, as Jellyfin's players default them. */
const SKIP_BACK_S = 10;
const SKIP_FORWARD_S = 30;
/** Quick skips add up on screen and go out as ONE seek once the taps stop, so a
 *  burst of them doesn't make the server restart its transcode for every step. */
const SKIP_COMMIT_MS = 450;
/** Two taps on the same side of the picture within this window skip. */
const DOUBLE_TAP_MS = 280;
/** A playhead that should be moving and hasn't for this long is re-seeked where it
 *  stands, which makes AVPlayer re-request what it's waiting for; if that doesn't
 *  get it going either, the stream is rebuilt there. */
const STUCK_RECOVER_MS = 8_000;
/** Seeks may land this far either side of the target: on a long-GOP file an exact
 *  seek decodes from the previous keyframe, which is what made skipping crawl. */
const SEEK_TOLERANCE_S = 1;

/** Seconds → "m:ss" (or "h:mm:ss"). */
function fmt(s: number): string {
  const total = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/**
 * Fullscreen playback for one movie/episode. Tries the direct-play stream first
 * (native seek via HTTP Range); if the container can't be decoded by AVPlayer
 * (e.g. some MKV/HEVC), falls back to a server-side HLS transcode.
 *
 * Custom controls (not the native ones) are required because a transcode is an
 * HLS *event* playlist that only spans what ffmpeg has encoded so far — the
 * native scrubber can't reach unencoded time. So the seek bar uses the *probed*
 * duration, and seeking in transcode mode RESTARTS ffmpeg at the target offset
 * (`startSec`) rather than trying to seek the player (mirrors the web player).
 */
export default function Player() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ type: string; id: string; title?: string }>();
  const type: PlayableType = params.type === "episode" ? "episode" : "movie";
  const id = Number(params.id);
  const title = params.title ?? "";

  const [error, setError] = useState<string | null>(null);

  // "direct" = byte-range file stream; "hls" = transcode fallback. In HLS mode the
  // reported position is hlsBaseRef (the ffmpeg `-ss` offset) + the player time.
  const modeRef = useRef<"direct" | "hls">("direct");
  const hlsBaseRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const resumeRef = useRef(0);
  const durationRef = useRef(0);
  const positionRef = useRef(0);
  const lastSaveRef = useRef(0);
  const fellBackRef = useRef(false);

  // UI state.
  const [duration, setDuration] = useState(0); // probed runtime (seek-bar range)
  const [displayTime, setDisplayTime] = useState(0); // absolute playhead
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  const [seeking, setSeeking] = useState(false);
  const seekingRef = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What the viewer wants, as opposed to what AVPlayer is doing: while it waits
  // for data it reports "not playing", and the button shouldn't flip to ▶ (nor
  // the watchdog think the viewer paused) every time it buffers.
  const [wantPlay, setWantPlay] = useState(true);
  const wantPlayRef = useRef(true);
  const intendPlay = useCallback((on: boolean) => {
    wantPlayRef.current = on;
    setWantPlay(on);
  }, []);

  // A burst of skips in progress: where it started and where it has got to.
  const pendingSeekRef = useRef<number | null>(null);
  const burstOriginRef = useRef(0);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [skipOsd, setSkipOsd] = useState<number | null>(null); // seconds, signed

  // Double-tap detection on the picture.
  const lastTapRef = useRef<{ at: number; side: "back" | "forward" | "center" } | null>(null);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1; // 1 s → a responsive seek bar
    p.staysActiveInBackground = true; // keep playing when the app is backgrounded
    p.seekTolerance = { toleranceBefore: SEEK_TOLERANCE_S, toleranceAfter: SEEK_TOLERANCE_S };
  });

  const { status, error: playerError } = useEvent(player, "statusChange", {
    status: player.status,
  });
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const { isPlaying: playing } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  // Follow pauses and plays that come from elsewhere (lock screen, PiP, the end of
  // the file). Not playing while ready means paused; not playing while loading is
  // only buffering, and says nothing about what the viewer wants.
  const hasPlayedRef = useRef(false);
  useEffect(() => {
    if (playing) {
      hasPlayedRef.current = true;
      intendPlay(true);
    } else if (status === "readyToPlay") intendPlay(false);
  }, [playing, status, intendPlay]);
  const statusRef = useRef(status);
  statusRef.current = status;

  // Auto-hide the controls a few seconds after they're shown (only while playing).
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);
  useEffect(() => {
    showControls();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [showControls]);

  // Boot: token + resume point + probed duration, then the direct stream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ token }, progress] = await Promise.all([
          getCastToken(),
          getWatchProgress(type, id).catch(() => null),
        ]);
        if (cancelled) return;
        tokenRef.current = token;
        if (progress && !progress.watched && progress.positionSeconds > 30) {
          resumeRef.current = progress.positionSeconds;
        }
        player.replace({ uri: streamUrl(type, id, token) });
        player.play();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not start playback");
      }
    })();
    // Probed runtime for the seek bar (a transcode's own duration is only the
    // encoded-so-far length, so we can't rely on it).
    getVersions(type, id)
      .then((v) => {
        const d = (v.versions.find((x) => x.isPrimary) ?? v.versions[0])?.durationSec ?? 0;
        if (!cancelled && d > 0) {
          durationRef.current = d;
          setDuration(d);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id]);

  /**
   * Start a transcode session at `startSec` and play it, retiring the previous
   * session. A seekable transcode's playlist covers the whole runtime, so its
   * timeline is absolute: no base offset, and the playhead is placed once it's
   * ready (resumeRef). Only the legacy event-playlist fallback starts AT
   * `startSec` (base offset = startSec, already positioned).
   */
  const openTranscode = useCallback(
    async (startSec: number) => {
      const token = tokenRef.current;
      if (!token) throw new Error("Not signed in");
      const start = Math.max(0, Math.floor(startSec));
      const old = sessionRef.current;
      const session = await startTranscode(type, id, start);
      sessionRef.current = session.sessionId;
      modeRef.current = "hls";
      hlsBaseRef.current = session.seekable ? 0 : start;
      resumeRef.current = session.seekable ? start : 0;
      positionRef.current = start;
      player.replace({ uri: transcodePlaylistUrl(session.url, token), contentType: "hls" });
      player.play();
      if (old && old !== session.sessionId) stopTranscode(old).catch(() => {});
    },
    [type, id, player]
  );

  // Direct play failed (unsupported container) → HLS transcode from the current spot.
  useEffect(() => {
    if (status !== "error") return;
    if (fellBackRef.current || !tokenRef.current) {
      setError(playerError?.message ?? "Playback failed");
      return;
    }
    fellBackRef.current = true;
    openTranscode(Math.max(positionRef.current, resumeRef.current)).catch((err) =>
      setError(err instanceof Error ? err.message : "Playback failed")
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Once the direct stream is ready: adopt its duration if we don't have a probed
  // one, and jump to the resume point (HLS already starts at the offset).
  useEffect(() => {
    if (status !== "readyToPlay") return;
    // Both direct play and a seekable transcode expose an absolute timeline, so
    // the resume point is applied the same way for each.
    if (durationRef.current <= 0 && player.duration > 0) {
      durationRef.current = player.duration;
      setDuration(player.duration);
    }
    if (resumeRef.current > 0 && hlsBaseRef.current === 0) {
      player.currentTime = resumeRef.current;
      resumeRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Playhead heartbeat: update the UI every tick, persist at most every 15 s.
  useEffect(() => {
    const position = modeRef.current === "hls" ? hlsBaseRef.current + currentTime : currentTime;
    if (!Number.isFinite(position) || position < 0) return;
    positionRef.current = position;
    if (scrubPreview == null && pendingSeekRef.current == null) setDisplayTime(position);
    if (durationRef.current > 0 && Math.abs(position - lastSaveRef.current) >= PROGRESS_SAVE_STEP_S) {
      lastSaveRef.current = position;
      saveWatchProgress(type, id, position, durationRef.current).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime]);

  // Teardown: final progress write + release the transcode session.
  useEffect(() => {
    return () => {
      if (positionRef.current > 0 && durationRef.current > 0) {
        saveWatchProgress(type, id, positionRef.current, durationRef.current).catch(() => {});
      }
      if (sessionRef.current) {
        stopTranscode(sessionRef.current).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Seek to an ABSOLUTE time. Direct play seeks over HTTP Range; a seekable
   * transcode seeks the same way (its playlist covers the whole runtime and the
   * server transcodes the requested segment on demand). Only the legacy
   * event-playlist fallback — whose timeline starts at `hlsBaseRef` — can't
   * reach unencoded time, so there we restart ffmpeg at the target instead.
   */
  const seekTo = useCallback(
    async (target: number) => {
      const t = Math.max(0, durationRef.current > 0 ? Math.min(target, durationRef.current) : target);
      if (modeRef.current === "direct" || hlsBaseRef.current === 0) {
        player.currentTime = t;
        positionRef.current = t;
        setDisplayTime(t);
        return;
      }
      seekingRef.current = true;
      setSeeking(true);
      setDisplayTime(t);
      try {
        await openTranscode(t);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Seek failed");
      } finally {
        seekingRef.current = false;
        setSeeking(false);
      }
    },
    [player, openTranscode]
  );

  /**
   * Skip by `delta` seconds. Quick skips add up: the bar and the bubble move at
   * once, and the seek itself goes out SKIP_COMMIT_MS after the last tap, from
   * where the burst started — one seek however many taps.
   */
  const skip = useCallback(
    (delta: number) => {
      if (pendingSeekRef.current == null) burstOriginRef.current = positionRef.current;
      const from = pendingSeekRef.current ?? positionRef.current;
      const max = durationRef.current > 0 ? durationRef.current : Number.POSITIVE_INFINITY;
      const target = Math.max(0, Math.min(from + delta, max));
      pendingSeekRef.current = target;
      setDisplayTime(target);
      setSkipOsd(Math.round(target - burstOriginRef.current));
      if (osdTimer.current) clearTimeout(osdTimer.current);
      if (skipTimer.current) clearTimeout(skipTimer.current);
      skipTimer.current = setTimeout(() => {
        const t = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (t != null) void seekTo(t);
        osdTimer.current = setTimeout(() => setSkipOsd(null), 600);
      }, SKIP_COMMIT_MS);
    },
    [seekTo]
  );
  useEffect(
    () => () => {
      if (skipTimer.current) clearTimeout(skipTimer.current);
      if (osdTimer.current) clearTimeout(osdTimer.current);
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
    },
    []
  );

  const togglePlay = useCallback(() => {
    if (wantPlayRef.current) {
      intendPlay(false);
      player.pause();
    } else {
      intendPlay(true);
      player.play();
    }
    showControls();
  }, [player, showControls, intendPlay]);

  // Watchdog. A playhead that should be moving and hasn't is waiting on data that
  // isn't coming: a segment request lost across a run of seeks, or a transcode
  // session the server has since reaped. Re-seek where it stands first (AVPlayer
  // re-requests); if it's still stuck, rebuild the stream at that spot.
  useEffect(() => {
    let last = -1;
    let stuckSince = Date.now();
    let reseeked = false;
    const tick = setInterval(() => {
      const now = Date.now();
      // Not before playback has ever started: a slow first segment is the
      // initial load's business (it falls back on its own), not a stall.
      const busy =
        !hasPlayedRef.current ||
        !wantPlayRef.current ||
        seekingRef.current ||
        pendingSeekRef.current != null ||
        statusRef.current === "error" ||
        statusRef.current === "idle";
      const t = player.currentTime;
      if (busy || t !== last) {
        last = t;
        stuckSince = now;
        reseeked = false;
        return;
      }
      if (now - stuckSince < STUCK_RECOVER_MS) return;
      stuckSince = now;
      if (!reseeked) {
        reseeked = true;
        player.currentTime = t;
        player.play();
        return;
      }
      reseeked = false;
      const at = positionRef.current;
      if (modeRef.current === "hls") {
        openTranscode(at).catch(() => {});
      } else if (tokenRef.current) {
        resumeRef.current = at;
        player.replace({ uri: streamUrl(type, id, tokenRef.current) });
        player.play();
      }
    }, 1_000);
    return () => clearInterval(tick);
  }, [player, openTranscode, type, id]);

  // Taps on the picture: once toggles the controls; twice on the left or right
  // third skips back or forward, and every further tap on that side while the
  // skip is still adding up skips again (as Jellyfin's and YouTube's players do).
  const onSurfacePress = useCallback(
    (e: GestureResponderEvent) => {
      const x = e.nativeEvent.locationX;
      const side = x < width * 0.35 ? "back" : x > width * 0.65 ? "forward" : "center";
      const now = Date.now();
      const last = lastTapRef.current;
      lastTapRef.current = { at: now, side };
      const toggle = () => (controlsVisible ? setControlsVisible(false) : showControls());
      if (side === "center") {
        toggle();
        return;
      }
      const doubled = last?.side === side && now - last.at < DOUBLE_TAP_MS;
      const continuing = pendingSeekRef.current != null && last?.side === side;
      if (doubled || continuing) {
        if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
        singleTapTimer.current = null;
        skip(side === "back" ? -SKIP_BACK_S : SKIP_FORWARD_S);
        return;
      }
      // Maybe the first of a double tap: wait before treating it as a single one.
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
      singleTapTimer.current = setTimeout(() => {
        singleTapTimer.current = null;
        toggle();
      }, DOUBLE_TAP_MS);
    },
    [width, controlsVisible, showControls, skip]
  );

  const barValue = scrubPreview != null ? scrubPreview : displayTime;

  return (
    <View style={styles.root}>
      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Playback failed</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <>
          <VideoView
            player={player}
            style={styles.video}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture
            // Auto-PiP on backgrounding is an iOS behaviour; on Android it needs
            // activity-level config that Expo Go doesn't provide, so don't ask
            // for it there.
            startsPictureInPictureAutomatically={Platform.OS === "ios"}
          />
          {/* Tap to toggle the controls; double-tap a side to skip. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={onSurfacePress} />
        </>
      )}

      {(status === "loading" || seeking) && !error && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={theme.accent} />
          {!!title && !hasPlayedRef.current && <Text style={styles.loadingTitle}>{title}</Text>}
        </View>
      )}

      {skipOsd != null && skipOsd !== 0 && !error && (
        <View
          pointerEvents="none"
          style={[styles.skipOsd, skipOsd < 0 ? styles.skipOsdBack : styles.skipOsdForward]}
        >
          <Text style={styles.skipOsdText}>
            {skipOsd < 0 ? `« ${-skipOsd}s` : `${skipOsd}s »`}
          </Text>
        </View>
      )}

      {/* Close (always available). */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        style={[styles.close, { top: insets.top + 8 }]}
      >
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      {controlsVisible && !error && (
        <>
          {!!title && (
            <Text style={[styles.title, { top: insets.top + 12 }]} numberOfLines={1}>
              {title}
            </Text>
          )}
          <View style={styles.transport} pointerEvents="box-none">
            <Pressable
              style={styles.skipBtn}
              onPress={() => {
                showControls();
                skip(-SKIP_BACK_S);
              }}
              hitSlop={12}
              accessibilityLabel={`Back ${SKIP_BACK_S} seconds`}
            >
              <Text style={styles.skipIcon}>↺</Text>
              <Text style={styles.skipLabel}>{SKIP_BACK_S}</Text>
            </Pressable>
            <Pressable style={styles.playBtn} onPress={togglePlay} hitSlop={16}>
              <Text style={styles.playIcon}>{wantPlay ? "❚❚" : "▶"}</Text>
            </Pressable>
            <Pressable
              style={styles.skipBtn}
              onPress={() => {
                showControls();
                skip(SKIP_FORWARD_S);
              }}
              hitSlop={12}
              accessibilityLabel={`Forward ${SKIP_FORWARD_S} seconds`}
            >
              <Text style={styles.skipIcon}>↻</Text>
              <Text style={styles.skipLabel}>{SKIP_FORWARD_S}</Text>
            </Pressable>
          </View>
          <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]}>
            <Text style={styles.time}>{fmt(barValue)}</Text>
            <Scrubber
              duration={duration}
              value={barValue}
              onScrub={setScrubPreview}
              onSeek={(t) => {
                showControls();
                void seekTo(t);
              }}
            />
            <Text style={styles.time}>{fmt(duration)}</Text>
          </View>
        </>
      )}
    </View>
  );
}

/** A draggable progress bar built on PanResponder (no extra native deps). */
function Scrubber({
  duration,
  value,
  onScrub,
  onSeek,
}: {
  duration: number;
  value: number;
  onScrub: (t: number | null) => void;
  onSeek: (t: number) => void;
}) {
  const widthRef = useRef(0);
  const durRef = useRef(duration);
  durRef.current = duration;
  const [drag, setDrag] = useState<number | null>(null);

  const frac = (e: GestureResponderEvent) =>
    Math.max(0, Math.min(1, e.nativeEvent.locationX / (widthRef.current || 1)));

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const t = frac(e) * durRef.current;
        setDrag(t);
        onScrub(t);
      },
      onPanResponderMove: (e) => {
        const t = frac(e) * durRef.current;
        setDrag(t);
        onScrub(t);
      },
      onPanResponderRelease: (e) => {
        const t = frac(e) * durRef.current;
        setDrag(null);
        onScrub(null);
        onSeek(t);
      },
      onPanResponderTerminate: () => {
        setDrag(null);
        onScrub(null);
      },
    })
  ).current;

  const shown = drag != null ? drag : value;
  const pct = duration > 0 ? Math.max(0, Math.min(1, shown / duration)) * 100 : 0;

  return (
    <View
      style={styles.track}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
      {...pan.panHandlers}
    >
      <View style={styles.trackBg} pointerEvents="none" />
      <View style={[styles.trackFill, { width: `${pct}%` }]} pointerEvents="none" />
      <View style={[styles.thumb, { left: `${pct}%` }]} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  video: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  errorTitle: { color: theme.text, fontSize: 18, fontWeight: "700" },
  errorText: { color: theme.muted, fontSize: 14, textAlign: "center" },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingTitle: { color: theme.muted, fontSize: 15 },
  close: {
    position: "absolute",
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { color: theme.text, fontSize: 16, fontWeight: "600" },
  title: {
    position: "absolute",
    left: 60,
    right: 16,
    color: theme.text,
    fontSize: 15,
    fontWeight: "600",
  },
  transport: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    marginTop: -34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 44,
  },
  playBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: { color: theme.text, fontSize: 24, fontWeight: "800" },
  skipBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  skipIcon: { color: theme.text, fontSize: 26, lineHeight: 28 },
  skipLabel: { color: theme.text, fontSize: 10, fontWeight: "700", marginTop: -2 },
  skipOsd: {
    position: "absolute",
    top: "50%",
    marginTop: -22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  skipOsdBack: { left: "10%" },
  skipOsdForward: { right: "10%" },
  skipOsdText: { color: theme.text, fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  time: { color: theme.text, fontSize: 12, fontVariant: ["tabular-nums"], minWidth: 44, textAlign: "center" },
  track: { flex: 1, height: 28, justifyContent: "center" },
  trackBg: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  trackFill: {
    position: "absolute",
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.accent,
  },
  thumb: {
    position: "absolute",
    width: 14,
    height: 14,
    marginLeft: -7,
    borderRadius: 7,
    backgroundColor: theme.accent,
  },
});
