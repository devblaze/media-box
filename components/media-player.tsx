"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Badge, Button, Callout, Modal, Spinner } from "@/components/ui";
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

/**
 * Video modal that plays a title either by DIRECT play (native `<video>` on the
 * gated stream route) or by TRANSCODE (server-side HLS via ffmpeg, loaded with
 * hls.js). The initial mode is chosen from {@link MediaInfo}; a toggle lets the
 * user switch, and a failed direct play offers a one-click transcode fallback.
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

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Playback</span>
          <Button
            variant={mode === "direct" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setMode("direct")}
          >
            Direct
          </Button>
          <Button
            variant={mode === "transcode" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setMode("transcode")}
          >
            Transcode
          </Button>
        </div>

        {mode === "direct" ? (
          <DirectPlayer
            src={`/api/v1/stream/${target.type}/${target.id}`}
            onFallback={() => setMode("transcode")}
          />
        ) : (
          <TranscodePlayer type={target.type} id={target.id} />
        )}
      </div>
    </Modal>
  );
}

/** Native direct play with a "Try transcoding" fallback on <video> error. */
function DirectPlayer({ src, onFallback }: { src: string; onFallback: () => void }) {
  const [errored, setErrored] = useState(false);

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        controls
        autoPlay
        className="w-full rounded bg-black"
        src={src}
        onError={() => setErrored(true)}
      />
      {errored ? (
        <Callout tone="warning" title="Direct play failed">
          <p>
            Your browser could not play this file directly. MP4/H.264/AAC plays natively; MKV, HEVC
            and other formats need transcoding.
          </p>
          <div className="mt-2">
            <Button size="sm" onClick={onFallback}>
              Try transcoding
            </Button>
          </div>
        </Callout>
      ) : (
        <Callout tone="info">
          Direct play — streaming the original file. If it does not start, switch to transcoding.
        </Callout>
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
function TranscodePlayer({ type, id }: PlaybackTarget) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "playing" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let hls: HlsInstance | null = null;
    let sessionId: string | null = null;

    async function start() {
      try {
        const res = await apiFetch<{ sessionId: string; url: string }>("/transcode", {
          method: "POST",
          body: JSON.stringify({ type, id }),
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
  }, [type, id]);

  return (
    <>
      <div className="relative">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} controls autoPlay className="w-full rounded bg-black" />
        {status === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded bg-black/70 text-sm text-zinc-300">
            <Spinner className="size-6" />
            <span>Starting transcode…</span>
          </div>
        )}
      </div>
      {status === "error" ? (
        <Callout tone="danger" title="Playback error">
          {error}
        </Callout>
      ) : (
        <Callout tone="info">
          Transcoding to a browser-friendly HLS stream. Seeking far ahead may pause while new
          segments are produced.
        </Callout>
      )}
    </>
  );
}
