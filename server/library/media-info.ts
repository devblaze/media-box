import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 30_000;
// ffprobe JSON for files with many streams can exceed the 1 MB default buffer.
const PROBE_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Normalised technical metadata for a media file. Persisted (as JSON) into the
 * `mediaInfo` column of `movieFiles` / `episodeFiles`. Every field is nullable
 * because a probe may only partially succeed and because ffprobe may be absent.
 */
export interface MediaInfo {
  container: string;
  durationSec: number | null;
  bitrate: number | null;
  video: {
    codec: string;
    width: number | null;
    height: number | null;
    hdr: string | null;
    /** ffprobe pixel format (for example yuv420p or yuv420p10le). */
    pixelFormat?: string | null;
  } | null;
  audio: {
    codec: string;
    channels: number | null;
    language: string | null;
  } | null;
  subtitles: { codec: string; language: string | null }[];
}

// ---- ffprobe JSON shapes (only the fields we consume) ----

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  channels?: number;
  color_transfer?: string;
  color_primaries?: string;
  disposition?: { default?: number; attached_pic?: number };
  tags?: { language?: string };
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

// Only warn once per process when the binary is missing, to avoid log spam
// across a large import batch.
let warnedMissing = false;

function toNumber(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Map ffprobe colour metadata to a friendly HDR label, or null for SDR. */
function detectHdr(stream: FfprobeStream): string | null {
  const transfer = (stream.color_transfer ?? "").toLowerCase();
  const primaries = (stream.color_primaries ?? "").toLowerCase();
  const haystack = `${transfer} ${primaries}`;
  if (haystack.includes("smpte2084")) return "HDR10";
  if (haystack.includes("arib-std-b67")) return "HLG";
  return null;
}

function mapOutput(absPath: string, data: FfprobeOutput): MediaInfo {
  const streams = data.streams ?? [];
  // Some containers expose cover art as the first video stream. Never treat an
  // attached poster as the playable picture stream.
  const videoStream =
    streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1) ??
    streams.find((s) => s.codec_type === "video");
  // Report the DEFAULT-disposition audio track — that's the one a browser plays
  // in direct play. On dual-audio files (e.g. AAC + default AC3) reporting the
  // first track made canDirectPlay approve direct play of an undecodable default
  // track → video with no sound. Fall back to the first track when none is
  // flagged default.
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const audioStream = audioStreams.find((s) => s.disposition?.default === 1) ?? audioStreams[0];
  const subtitleStreams = streams.filter((s) => s.codec_type === "subtitle");

  const container =
    data.format?.format_name?.split(",")[0]?.trim() ||
    path.extname(absPath).replace(/^\./, "").toLowerCase() ||
    "unknown";

  return {
    container,
    durationSec:
      toNumber(data.format?.duration) !== null
        ? Math.round(toNumber(data.format?.duration)!)
        : null,
    bitrate: toNumber(data.format?.bit_rate),
    video: videoStream
      ? {
          codec: videoStream.codec_name ?? "unknown",
          width: toNumber(videoStream.width),
          height: toNumber(videoStream.height),
          hdr: detectHdr(videoStream),
          pixelFormat: videoStream.pix_fmt ?? null,
        }
      : null,
    audio: audioStream
      ? {
          codec: audioStream.codec_name ?? "unknown",
          channels: toNumber(audioStream.channels),
          language: audioStream.tags?.language ?? null,
        }
      : null,
    subtitles: subtitleStreams.map((s) => ({
      codec: s.codec_name ?? "unknown",
      language: s.tags?.language ?? null,
    })),
  };
}

/**
 * Probe a media file with ffprobe and return normalised {@link MediaInfo}.
 *
 * Degrades gracefully: if ffprobe is not installed (ENOENT), times out, exits
 * non-zero, or returns unparseable JSON, this logs a single concise warning and
 * returns `null`. It NEVER throws, so callers (e.g. the importer) can treat the
 * result as best-effort enrichment.
 */
/** A chapter marker inside a media file (from ffprobe `-show_chapters`). */
export interface MediaChapter {
  startSeconds: number;
  endSeconds: number;
  title: string | null;
}

/**
 * Read chapter markers from a media file. Best-effort like {@link probeMediaInfo}:
 * returns `[]` when ffprobe is missing, times out, or the file has no chapters.
 */
export async function probeChapters(absPath: string): Promise<MediaChapter[]> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_chapters", absPath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER }
    );
    const data = JSON.parse(stdout) as {
      chapters?: { start_time?: string; end_time?: string; tags?: { title?: string } }[];
    };
    return (data.chapters ?? [])
      .map((c) => ({
        startSeconds: Math.max(0, Math.floor(toNumber(c.start_time) ?? 0)),
        endSeconds: Math.max(0, Math.floor(toNumber(c.end_time) ?? 0)),
        title: c.tags?.title ?? null,
      }))
      .filter((c) => c.endSeconds > c.startSeconds);
  } catch {
    return [];
  }
}

/** One audio stream inside a media file, with its `0:a:index` position. */
export interface AudioStream {
  index: number;
  codec: string;
  channels: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
}

interface FfprobeAudioStream {
  codec_name?: string;
  channels?: number;
  disposition?: { default?: number };
  tags?: { language?: string; title?: string };
}

/**
 * List all audio streams in a file (via ffprobe), in `0:a:index` order — so the
 * player can offer an audio-track picker and the transcoder can map a chosen one.
 * Best-effort: `[]` when ffprobe is missing/fails or there are no audio streams.
 */
export async function probeAudioTracks(absPath: string): Promise<AudioStream[]> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "a", absPath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER }
    );
    const data = JSON.parse(stdout) as { streams?: FfprobeAudioStream[] };
    return (data.streams ?? []).map((s, index) => ({
      index,
      codec: s.codec_name ?? "unknown",
      channels: toNumber(s.channels),
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      isDefault: s.disposition?.default === 1,
    }));
  } catch {
    return [];
  }
}

export async function probeMediaInfo(absPath: string): Promise<MediaInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", absPath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER }
    );
    const data = JSON.parse(stdout) as FfprobeOutput;
    return mapOutput(absPath, data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      if (!warnedMissing) {
        warnedMissing = true;
        console.warn("[media-info] ffprobe not found on PATH — media info will be skipped");
      }
      return null;
    }
    console.warn(
      `[media-info] probe failed for ${path.basename(absPath)}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
