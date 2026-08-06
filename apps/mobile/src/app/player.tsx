import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import {
  getCastToken,
  getWatchProgress,
  saveWatchProgress,
  startTranscode,
  stopTranscode,
  streamUrl,
  transcodePlaylistUrl,
  type PlayableType,
} from "@/lib/api";
import { theme } from "@/lib/theme";

const PROGRESS_INTERVAL_S = 15;

/**
 * Fullscreen playback for one movie/episode. Tries the direct-play stream
 * first (native seek via HTTP Range); if the container can't be decoded by
 * AVPlayer/ExoPlayer (e.g. some MKVs), falls back to a server-side HLS
 * transcode session. Auth uses the tokenized `?key=` URLs, resume position
 * comes from watch-progress, and progress heartbeats are PUT every 15 s.
 */
export default function Player() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ type: string; id: string; title?: string }>();
  const type: PlayableType = params.type === "episode" ? "episode" : "movie";
  const id = Number(params.id);
  const title = params.title ?? "";

  const [error, setError] = useState<string | null>(null);

  // "direct" = byte-range file stream; "hls" = transcode fallback. In HLS mode
  // the reported position is startSec + player time (the playlist starts at
  // the seek offset), tracked via hlsBaseRef.
  const modeRef = useRef<"direct" | "hls">("direct");
  const hlsBaseRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const resumeRef = useRef(0);
  const durationRef = useRef(0);
  const positionRef = useRef(0);
  const fellBackRef = useRef(false);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = PROGRESS_INTERVAL_S;
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

  // Boot: token + resume point, then hand the direct stream to the player.
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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id]);

  // Direct play failed (usually an unsupported container) → HLS transcode.
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
        hlsBaseRef.current = startSec;
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

  // Seek to the resume point once the direct stream is ready (HLS mode
  // already starts at the offset server-side).
  useEffect(() => {
    if (status !== "readyToPlay") return;
    durationRef.current = modeRef.current === "hls"
      ? hlsBaseRef.current + player.duration
      : player.duration;
    if (modeRef.current === "direct" && resumeRef.current > 0) {
      player.currentTime = resumeRef.current;
      resumeRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Heartbeat: remember + persist the playhead.
  useEffect(() => {
    const position = modeRef.current === "hls" ? hlsBaseRef.current + currentTime : currentTime;
    if (!Number.isFinite(position) || position <= 0) return;
    positionRef.current = position;
    if (durationRef.current > 0) {
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

  return (
    <View style={styles.root}>
      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Playback failed</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <VideoView
          player={player}
          style={styles.video}
          contentFit="contain"
          allowsPictureInPicture
        />
      )}
      {status === "loading" && !error && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={theme.accent} />
          {!!title && <Text style={styles.loadingTitle}>{title}</Text>}
        </View>
      )}
      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        style={[styles.close, { top: insets.top + 8 }]}
      >
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
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
});
