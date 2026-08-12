import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
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
  const [isPlaying, setIsPlaying] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1; // 1 s → a responsive seek bar
    p.staysActiveInBackground = true; // keep playing when the app is backgrounded
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
  useEffect(() => setIsPlaying(playing), [playing]);

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

  // Direct play failed (unsupported container) → HLS transcode from the current spot.
  useEffect(() => {
    if (status !== "error") return;
    if (fellBackRef.current || !tokenRef.current) {
      setError(playerError?.message ?? "Playback failed");
      return;
    }
    fellBackRef.current = true;
    (async () => {
      try {
        const startSec = Math.max(positionRef.current, resumeRef.current);
        const session = await startTranscode(type, id, startSec);
        sessionRef.current = session.sessionId;
        modeRef.current = "hls";
        // A seekable transcode's playlist covers the whole runtime, so its
        // timeline is absolute — no base offset, and we seek to the resume
        // point ourselves. Only the legacy event-playlist fallback starts AT
        // `startSec` (base offset = startSec, already positioned).
        hlsBaseRef.current = session.seekable ? 0 : startSec;
        if (session.seekable && startSec > 0) resumeRef.current = startSec;
        player.replace({
          uri: transcodePlaylistUrl(session.url, tokenRef.current!),
          contentType: "hls",
        });
        player.play();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Playback failed");
      }
    })();
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
    if (scrubPreview == null) setDisplayTime(position);
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

  // Seek to an ABSOLUTE time. Direct play seeks natively (HTTP Range); a transcode
  // can't seek to unencoded time, so it restarts ffmpeg at the target offset.
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
      showControls();
      if (modeRef.current === "direct" || hlsBaseRef.current === 0) {
        player.currentTime = t;
        positionRef.current = t;
        setDisplayTime(t);
        return;
      }
      const token = tokenRef.current;
      if (!token) return;
      setSeeking(true);
      setDisplayTime(t);
      const old = sessionRef.current;
      try {
        const session = await startTranscode(type, id, Math.floor(t));
        sessionRef.current = session.sessionId;
        hlsBaseRef.current = session.seekable ? 0 : Math.floor(t);
        positionRef.current = t;
        player.replace({
          uri: transcodePlaylistUrl(session.url, token),
          contentType: "hls",
        });
        player.play();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Seek failed");
      } finally {
        setSeeking(false);
        if (old && old !== sessionRef.current) stopTranscode(old).catch(() => {});
      }
    },
    [type, id, player, showControls]
  );

  const togglePlay = useCallback(() => {
    if (player.playing) player.pause();
    else player.play();
    showControls();
  }, [player, showControls]);

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
            startsPictureInPictureAutomatically
          />
          {/* Tap anywhere to toggle the controls. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => (controlsVisible ? setControlsVisible(false) : showControls())}
          />
        </>
      )}

      {(status === "loading" || seeking) && !error && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={theme.accent} />
          {!!title && <Text style={styles.loadingTitle}>{title}</Text>}
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
          <Pressable style={styles.playBtn} onPress={togglePlay} hitSlop={16}>
            <Text style={styles.playIcon}>{isPlaying ? "❚❚" : "▶"}</Text>
          </Pressable>
          <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]}>
            <Text style={styles.time}>{fmt(barValue)}</Text>
            <Scrubber
              duration={duration}
              value={barValue}
              onScrub={setScrubPreview}
              onSeek={seekTo}
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
  playBtn: {
    position: "absolute",
    alignSelf: "center",
    top: "48%",
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: { color: theme.text, fontSize: 24, fontWeight: "800" },
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
