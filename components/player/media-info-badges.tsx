"use client";

import { Badge } from "@/components/ui";
import type { MediaInfo } from "@/server/library/media-info";

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
