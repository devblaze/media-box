import type { MediaInfo } from "@/server/library/media-info";

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
export function canDirectPlay(info: MediaInfo | null | undefined): boolean {
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
