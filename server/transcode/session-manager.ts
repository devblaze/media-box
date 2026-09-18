import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG_DIR } from "@/server/config/paths";
import { getSettings } from "@/server/settings/settings-service";
import { probeAudioTracks, probeMediaInfo } from "@/server/library/media-info";
import { recordLog } from "@/server/logging/logger";
import { FFMPEG_BIN } from "./ffmpeg-path";
import {
  DEFAULT_TRANSCODE_QUALITY,
  transcodeQuality,
  type TranscodeQuality,
} from "@/lib/transcode-quality";

const execFileAsync = promisify(execFile);

// ---- tunables ----
const REAP_INTERVAL_MS = 30_000;
/** Reap any session not touched for this long, whatever its status. */
const IDLE_TTL_MS = 90_000;
/** Reap finished/failed sessions sooner once nobody is watching. */
const TERMINAL_TTL_MS = 30_000;
const STDERR_KEEP = 4_000; // cap captured stderr so a chatty run can't grow unbounded

// ---- seekable (VOD) transcode ----
/** Seconds per HLS segment (kept in lock-step with force_key_frames / hls_time). */
const SEG_DUR = 4;
/** A requested segment this many past the produced frontier is treated as a
 *  forward seek → ffmpeg is restarted there instead of waiting the encode out. */
const AHEAD_SEGMENTS = 12;
/** How long a segment request waits for its file before giving up. */
const SEGMENT_WAIT_MS = 20_000;
const SEGMENT_POLL_MS = 120;

export type TranscodeStatus = "starting" | "running" | "done" | "error";

export interface Session {
  id: string;
  absPath: string;
  dir: string;
  proc: ChildProcess | null;
  status: TranscodeStatus;
  /** ms epoch (Date.now()) of last playlist/segment access — drives the reaper. */
  lastAccess: number;
  error?: string;
  // ---- seekable (VOD) transcode ----
  /** ffprobe-measured runtime (seconds). 0 when unknown. */
  durationSec: number;
  /** Total segment count = ceil(durationSec / SEG_DUR). 0 when duration unknown. */
  segmentCount: number;
  /** Resolved 0-based audio-stream index the encoder maps. */
  audioTrack: number | null;
  /** Segment index the CURRENT ffmpeg run started at (its `-start_number`). */
  encoderStart: number;
  /** Bitrate rung this session encodes to. Fixed for the session's life — a
   *  different rung means a different session (the playlist has no ABR ladder). */
  quality: TranscodeQuality;
}

export interface StartOpts {
  /** Seek offset (seconds) applied as an input `-ss` before the file is opened. */
  startSec?: number;
  /** 0-based audio-stream index to map (`0:a:index`). Defaults to the first track. */
  audioTrack?: number;
  /** Bitrate rung id (see `lib/transcode-quality`). Unknown/absent → the top rung. */
  quality?: string;
}

/** Thrown when the configured concurrent-session cap is already reached. */
export class CapReachedError extends Error {
  constructor(cap: number) {
    super(`Transcode capacity reached (${cap} concurrent sessions)`);
    this.name = "CapReachedError";
  }
}

/** Thrown when the ffmpeg binary is not available on PATH. */
export class FfmpegMissingError extends Error {
  constructor() {
    super("ffmpeg not available");
    this.name = "FfmpegMissingError";
  }
}

// ---- singletons on globalThis (survive dev HMR module reloads) ----

const SESSIONS_KEY = Symbol.for("mediabox.transcode.sessions");
const REAPER_KEY = Symbol.for("mediabox.transcode.reaper");

type GlobalWithSessions = typeof globalThis & {
  [SESSIONS_KEY]?: Map<string, Session>;
  [REAPER_KEY]?: boolean;
};

function sessions(): Map<string, Session> {
  const g = globalThis as GlobalWithSessions;
  if (!g[SESSIONS_KEY]) g[SESSIONS_KEY] = new Map();
  return g[SESSIONS_KEY];
}

const TRANSCODE_ROOT = path.join(CONFIG_DIR, "transcode");

// ---- ffmpeg argument construction ----

type HwAccel = "none" | "vaapi" | "qsv" | "nvenc";

/**
 * Input-side flags (must precede `-i`). Decoding is deliberately done in
 * SOFTWARE for every mode — only the (expensive) encode is offloaded to the GPU.
 * Hardware *decoding* of 10-bit HEVC (the typical anime source) is exactly where
 * older iGPUs/drivers produce smeared, blocky frames or fail mid-stream; software
 * decode is cheap next to the encode and behaves identically for every codec.
 * `device` is the DRM render node (`/dev/dri/renderD12x`); it pins VAAPI and QSV
 * to a specific GPU — essential when the host has more than one (e.g. a dedicated
 * transcode card alongside an AI card).
 */
function hwaccelInputArgs(mode: HwAccel, device: string): string[] {
  switch (mode) {
    case "vaapi":
      // Device init only (for the encoder); frames are uploaded in videoArgs.
      return ["-vaapi_device", device || "/dev/dri/renderD128"];
    case "qsv":
      // `-qsv_device <render node>` pins the QSV encoder to a specific Intel GPU.
      return device ? ["-qsv_device", device] : [];
    case "nvenc":
    case "none":
    default:
      return [];
  }
}

/**
 * Every source (incl. 10-bit HEVC) is downscaled to the rung's height and
 * converted to 8-bit nv12/yuv420p BEFORE the encoder, so no encoder ever sees a
 * pixel format it can't handle. `min(h,ih)` only ever scales DOWN.
 */
function downscale(height: number): string {
  return `scale=-2:'min(${height},ih)'`;
}

/**
 * Output-side video encoder flags per hardware mode, for one bitrate rung.
 *
 * The top rung keeps the long-standing quality-targeted settings (constant
 * quality, generously capped) — that is what a healthy LAN should get. Every
 * lower rung switches to a hard bitrate ceiling instead, because the point of
 * those rungs is fitting a stream down a link that has a known, small capacity:
 * "roughly this good" is no use when the budget is 1 Mbps.
 */
function videoArgs(mode: HwAccel, quality: TranscodeQuality): string[] {
  const vf = downscale(quality.height);
  const capped = quality.id !== DEFAULT_TRANSCODE_QUALITY.id;
  const rate = quality.videoKbps;
  // VBV: a ceiling plus two seconds of buffer, so a busy scene borrows bits from
  // a quiet one without ever outrunning the link.
  const vbv = ["-maxrate", `${rate}k`, "-bufsize", `${rate * 2}k`];
  switch (mode) {
    case "vaapi":
      return capped
        ? [
            "-vf",
            `${vf},format=nv12,hwupload`,
            "-c:v",
            "h264_vaapi",
            "-rc_mode",
            "VBR",
            "-b:v",
            `${rate}k`,
            ...vbv,
          ]
        : ["-vf", `${vf},format=nv12,hwupload`, "-c:v", "h264_vaapi", "-qp", "23"];
    case "qsv":
      return capped
        ? ["-vf", `${vf},format=nv12`, "-c:v", "h264_qsv", "-b:v", `${rate}k`, ...vbv]
        : ["-vf", `${vf},format=nv12`, "-c:v", "h264_qsv", "-global_quality", "23"];
    case "nvenc":
      return capped
        ? [
            "-vf",
            `${vf},format=nv12`,
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-rc",
            "vbr",
            "-b:v",
            `${rate}k`,
            ...vbv,
          ]
        : ["-vf", `${vf},format=nv12`, "-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"];
    case "none":
    default:
      return [
        // Software (libx264) can't keep up with 4K/1440p in real time, so the
        // encoder falls behind playback → the stalls/"won't play" people hit.
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        // Capped CRF: spend fewer bits than the ceiling when the picture is easy,
        // never more than it when the picture is hard.
        "-crf",
        capped ? "23" : "21",
        ...vbv,
        "-pix_fmt",
        "yuv420p",
        // Keyframes ONLY at the forced 4s boundaries (no mid-segment scene-cut
        // IDRs) → every segment starts on a keyframe. A segment that doesn't is
        // undecodable on its own; if hls.js starts/recovers there, the picture
        // smears into blocky garbage until the next keyframe.
        "-sc_threshold",
        "0",
      ];
  }
}

/** Build the full ffmpeg argv for a seekable HLS (mpegts) transcode that begins at
 *  `startSegment` (segment index) and numbers its segments by absolute position.
 *  `quality` is the bitrate rung the output is pinned to (default: the top one). */
export function buildFfmpegArgs(
  absPath: string,
  dir: string,
  mode: HwAccel,
  vaapiDevice: string,
  startSegment: number,
  audioTrack?: number,
  quality: TranscodeQuality = DEFAULT_TRANSCODE_QUALITY
): string[] {
  const startSec = Math.max(0, startSegment) * SEG_DUR;
  const seek = startSec > 0 ? ["-ss", String(startSec)] : [];
  const audioIndex = Number.isInteger(audioTrack) && audioTrack! >= 0 ? audioTrack! : 0;
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...hwaccelInputArgs(mode, vaapiDevice),
    ...seek,
    "-i",
    absPath,
    // Preserve SOURCE timestamps so segments produced by different runs (after a
    // seek restart) share one absolute timeline — a coherent, seekable VOD.
    "-copyts",
    "-map",
    "0:v:0",
    "-map",
    `0:a:${audioIndex}?`,
    ...videoArgs(mode, quality),
    // Force a keyframe at every 4 s segment boundary. Timestamps are absolute
    // (`-copyts`), so the expression is anchored at this run's start offset —
    // otherwise every early frame would be forced to a keyframe after a seek.
    "-force_key_frames",
    `expr:gte(t,${startSec}+n_forced*4)`,
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    `${quality.audioKbps}k`,
    // Stretch/squeeze audio to its timestamps so long files can't drift out of
    // A/V sync (drifty sources play "weird" — lips ahead/behind the picture).
    "-af",
    "aresample=async=1",
    // Some files interleave audio and video far apart; a larger mux queue avoids
    // ffmpeg aborting with "Too many packets buffered for output stream" (which
    // manifests as a transcode that just never plays).
    "-max_muxing_queue_size",
    "1024",
    "-sn",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_playlist_type",
    "event",
    // Number segments by ABSOLUTE position: seg{i} is always the film's
    // [i*4, (i+1)*4) window, whichever run produced it. This is what makes a
    // restart-on-seek transparent to the (VOD) playlist.
    "-start_number",
    String(Math.max(0, startSegment)),
    // temp_file: write each segment to a temp name and rename when complete, so
    // a client can never read a half-written .ts (truncated segments decode as
    // corrupted smears and stall playback).
    "-hls_flags",
    "independent_segments+temp_file",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    path.join(dir, "seg%05d.ts"),
    path.join(dir, "index.m3u8"),
  ];
}

// ---- session lifecycle ----

/** Number of sessions currently occupying a transcode slot. */
function activeCount(): number {
  let n = 0;
  for (const s of sessions().values()) {
    if (s.status === "starting" || s.status === "running") n++;
  }
  return n;
}

/** Cheap feature-detect: does `ffmpeg -version` run? Never throws. */
async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync(FFMPEG_BIN, ["-version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ---- hardware-acceleration self-test ----

const HW_LABELS: Record<HwAccel, string> = {
  none: "Software (CPU / libx264)",
  vaapi: "Intel VAAPI",
  qsv: "Intel QSV",
  nvenc: "NVIDIA NVENC",
};

/**
 * A tiny synthetic encode used to verify that a given encode path actually
 * works on this machine. It feeds ffmpeg a 1-second generated clip and encodes
 * a few frames with the selected encoder to a null muxer — no real file needed.
 * For VAAPI the frames are uploaded to the GPU (which also exercises the device).
 */
function buildHwTestArgs(mode: HwAccel, device: string): string[] {
  const src = ["-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10"];
  const base = ["-hide_banner", "-loglevel", "error"];
  switch (mode) {
    case "vaapi":
      return [
        ...base,
        "-vaapi_device",
        device || "/dev/dri/renderD128",
        ...src,
        "-vf",
        "format=nv12,hwupload",
        "-c:v",
        "h264_vaapi",
        "-f",
        "null",
        "-",
      ];
    case "qsv":
      // Pin the self-test to the chosen GPU too, so it validates the right card.
      return [
        ...base,
        ...(device ? ["-qsv_device", device] : []),
        ...src,
        "-c:v",
        "h264_qsv",
        "-f",
        "null",
        "-",
      ];
    case "nvenc":
      return [...base, ...src, "-c:v", "h264_nvenc", "-f", "null", "-"];
    case "none":
    default:
      return [...base, ...src, "-c:v", "libx264", "-preset", "ultrafast", "-f", "null", "-"];
  }
}

export interface TranscodeTestResult {
  ok: boolean;
  /** False when the ffmpeg binary itself is missing (distinct from an encoder failure). */
  ffmpegAvailable: boolean;
  mode: HwAccel;
  label: string;
  message: string;
}

/**
 * Say what actually went wrong with a hardware encode, rather than guessing.
 *
 * The old message blamed GPU passthrough for every failure. On an Arc A380 that
 * sent people hunting a passthrough problem they did not have: the card was
 * mapped in correctly and VAAPI was encoding fine, while QSV failed because
 * Debian 12's ffmpeg links Intel's old Media SDK, which stops at 12th-generation
 * integrated graphics. The fix there is a newer ffmpeg, not a different
 * `--device` flag, and the message needs to say so.
 *
 * Matching on ffmpeg's own words, most specific first.
 */
export function diagnoseHwFailure(mode: HwAccel, stderr: string): string {
  const detail = summarizeFfmpegError(stderr);
  const label = HW_LABELS[mode];

  // Intel's Media SDK refusing to start. Almost always a card newer than the
  // ffmpeg build, which is the whole Arc story.
  if (/MFX|libmfx|oneVPL|VPL/i.test(stderr)) {
    return (
      `${label} failed to start a session, which usually means this ffmpeg build is older than the GPU. ` +
      "Intel's Media SDK stops at 12th-generation integrated graphics; Arc cards need a build with oneVPL. " +
      "VAAPI drives the same card through the graphics driver and is the working option in the meantime. " +
      `(${detail})`
    );
  }
  // Present but unreadable: a permissions problem, not a missing device.
  if (/Permission denied|EACCES/i.test(stderr)) {
    return (
      `${label} found the GPU device but was not allowed to open it. The container user needs access ` +
      "to the render node — on Unraid that usually means adding it to the render group. " +
      `(${detail})`
    );
  }
  // The render node is genuinely absent — this IS a passthrough problem.
  if (/No such file or directory|Failed to open.*(dri|renderD)|No VA display|cannot open display/i.test(stderr)) {
    return (
      `${label} could not open the GPU device. Check the render node is passed into the container ` +
      "(a /dev/dri device mapping) and that the device setting names one that exists. " +
      `(${detail})`
    );
  }
  // The encoder simply isn't compiled in.
  if (/Unknown encoder|Unrecognized option|Cannot load/i.test(stderr)) {
    return `${label} is not available in this ffmpeg build. (${detail})`;
  }
  return `${label} did not work. (${detail})`;
}

/** Pull the most useful line out of ffmpeg's stderr for a failed self-test. */
function summarizeFfmpegError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.reverse().find((l) => !/^\[/.test(l)) ?? lines[0];
  return meaningful ? meaningful.slice(0, 300) : "ffmpeg failed with no output.";
}

/**
 * Verify that the configured transcoding path works end-to-end. Returns a
 * structured result (never throws): whether ffmpeg exists, whether the selected
 * encoder ran, and a human-readable message for the settings UI.
 */
export async function testTranscode(
  mode: HwAccel,
  vaapiDevice: string
): Promise<TranscodeTestResult> {
  const label = HW_LABELS[mode];
  if (!(await ffmpegAvailable())) {
    return {
      ok: false,
      ffmpegAvailable: false,
      mode,
      label,
      message: "ffmpeg is not installed on the server, so transcoding is unavailable.",
    };
  }
  try {
    await execFileAsync(FFMPEG_BIN, buildHwTestArgs(mode, vaapiDevice), { timeout: 25_000 });
    return {
      ok: true,
      ffmpegAvailable: true,
      mode,
      label,
      message:
        mode === "none"
          ? "Software encoding works."
          : `${label} hardware encoding works and is ready to use.`,
    };
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    const detail = summarizeFfmpegError(stderr);
    return {
      ok: false,
      ffmpegAvailable: true,
      mode,
      label,
      message:
        mode === "none" ? `Software encoding failed: ${detail}` : diagnoseHwFailure(mode, stderr),
    };
  }
}

/**
 * Start an HLS transcode of `absPath`. Resolves once the ffmpeg process has been
 * spawned — it does NOT wait for the transcode to finish; segments stream to disk
 * and are served as they appear.
 *
 * @throws {CapReachedError}   the concurrency cap is already reached
 * @throws {FfmpegMissingError} ffmpeg is not installed
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const segName = (i: number) => `seg${String(i).padStart(5, "0")}.ts`;

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Highest segment index currently on disk for a session, or -1 if none. */
function producedFrontier(session: Session): number {
  let max = -1;
  try {
    for (const name of fs.readdirSync(session.dir)) {
      const m = /^seg(\d{5})\.ts$/.exec(name);
      if (m) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
    }
  } catch {
    // dir may not exist yet
  }
  return max;
}

/**
 * (Re)spawn the ffmpeg encoder for a session starting at `startSegment`, wiring the
 * stderr/exit handlers. Guards every callback on `session.proc === proc` so the
 * kill of a superseded run (on a seek restart) can't flip the session to error.
 */
function spawnEncoder(session: Session, startSegment: number): void {
  const settings = getSettings();
  const args = buildFfmpegArgs(
    session.absPath,
    session.dir,
    settings.transcodeHwAccel,
    settings.transcodeVaapiDevice,
    startSegment,
    session.audioTrack ?? undefined,
    session.quality
  );

  const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
  session.proc = proc;
  session.encoderStart = startSegment;
  session.status = "running";

  let stderrTail = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_KEEP);
  });

  proc.on("error", (err) => {
    if (session.proc !== proc) return; // superseded by a restart
    session.status = "error";
    session.error = err instanceof Error ? err.message : String(err);
  });

  proc.on("exit", (code) => {
    if (session.proc !== proc) return; // superseded by a restart — ignore its exit
    if (session.status === "error") return;
    if (code === 0) {
      session.status = "done";
    } else {
      session.status = "error";
      session.error = stderrTail.trim() || `ffmpeg exited with code ${code ?? "unknown"}`;
      recordLog("error", `Transcode of '${path.basename(session.absPath)}' failed`, {
        source: "transcode",
        context: { code, stderr: session.error.slice(0, 2_000), args: args.join(" ") },
      });
    }
  });
}

/** Kill the current run, drop its segments, and restart ffmpeg at `startSegment`.
 *  Clearing the dir keeps {@link producedFrontier} reflecting ONLY the new run, so
 *  the wait/restart decision stays unambiguous (a re-transcode on a backward seek
 *  is cheap next to getting that decision wrong). */
function restartEncoderAt(session: Session, startSegment: number): void {
  const old = session.proc;
  session.proc = null;
  try {
    old?.kill("SIGKILL");
  } catch {
    // already gone
  }
  try {
    for (const name of fs.readdirSync(session.dir)) {
      if (/^seg\d{5}\.ts$/.test(name) || name === "index.m3u8") {
        fs.rmSync(path.join(session.dir, name), { force: true });
      }
    }
  } catch {
    // best-effort
  }
  spawnEncoder(session, startSegment);
}

/**
 * Ensure segment `segIndex` exists (transcoded), then resolve true. If the current
 * encoder is producing toward it, wait; if it's a seek away from the encoder's
 * frontier (far ahead, or before its start), restart ffmpeg there. Resolves false
 * if the segment can't be produced before the deadline (or the encoder errored).
 */
export async function ensureSegment(session: Session, segIndex: number): Promise<boolean> {
  const file = path.join(session.dir, segName(segIndex));
  if (await fileExists(file)) return true;

  const frontier = producedFrontier(session);
  const effFrontier = Math.max(frontier, session.encoderStart - 1);
  const running = session.status === "running" || session.status === "starting";
  // The current run will reach segIndex "soon" only if it's ahead of (or at) the
  // encoder's start AND within a small window of the produced frontier.
  const reachesSoon =
    running && segIndex >= session.encoderStart && segIndex - effFrontier <= AHEAD_SEGMENTS;
  if (!reachesSoon) restartEncoderAt(session, segIndex);

  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (!(await fileExists(file))) {
    if (session.status === "error" || Date.now() >= deadline) return false;
    await sleep(SEGMENT_POLL_MS);
  }
  return true;
}

/** The VOD playlist: every segment of the WHOLE runtime listed up front, so the
 *  player's native scrubber knows the full length and can request any segment
 *  (produced on demand). `?key=` is appended to segment URIs by the route. */
export function buildVodPlaylist(session: Session): string {
  const n = session.segmentCount;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEG_DUR}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (let i = 0; i < n; i++) {
    const segLen = i === n - 1 ? Math.max(0.1, session.durationSec - i * SEG_DUR) : SEG_DUR;
    lines.push(`#EXTINF:${segLen.toFixed(3)},`);
    lines.push(segName(i));
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export async function startSession(absPath: string, opts: StartOpts = {}): Promise<Session> {
  const settings = getSettings();
  const cap = settings.maxTranscodeSessions;
  if (activeCount() >= cap) throw new CapReachedError(cap);

  if (!(await ffmpegAvailable())) throw new FfmpegMissingError();

  ensureReaper();

  // No explicit track chosen → transcode the file's DEFAULT audio track (what a
  // browser would play in direct play), not blindly the first one. On dual-audio
  // files whose default is the second stream, `0:a:0` played the wrong language.
  let audioTrack = opts.audioTrack ?? null;
  if (audioTrack == null) {
    const tracks = await probeAudioTracks(absPath).catch(() => []);
    const def = tracks.find((t) => t.isDefault);
    if (def) audioTrack = def.index;
  }

  // Probe the runtime so the playlist advertises the WHOLE film up front (the seek
  // bar range) even though only part is ever encoded at once.
  const info = await probeMediaInfo(absPath).catch(() => null);
  const durationSec = info?.durationSec && info.durationSec > 0 ? info.durationSec : 0;

  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(TRANSCODE_ROOT, id);
  const startSegment =
    opts.startSec && opts.startSec > 0 ? Math.floor(opts.startSec / SEG_DUR) : 0;

  const session: Session = {
    id,
    absPath,
    dir,
    proc: null,
    status: "starting",
    lastAccess: Date.now(),
    durationSec,
    segmentCount: durationSec > 0 ? Math.ceil(durationSec / SEG_DUR) : 0,
    audioTrack,
    encoderStart: startSegment,
    quality: transcodeQuality(opts.quality),
  };
  sessions().set(id, session);

  try {
    fs.mkdirSync(dir, { recursive: true });
    spawnEncoder(session, startSegment);
    return session;
  } catch (err) {
    // mkdir / spawn threw synchronously — clean up and re-throw a typed error.
    session.status = "error";
    session.error = err instanceof Error ? err.message : String(err);
    stopSession(id);
    throw err;
  }
}

export function getSession(id: string): Session | undefined {
  return sessions().get(id);
}

/** Mark a session as freshly used so the reaper leaves it alone. */
export function touch(id: string): void {
  const s = sessions().get(id);
  if (s) s.lastAccess = Date.now();
}

/** Kill the process, remove the segment dir, and forget the session. Idempotent. */
export function stopSession(id: string): void {
  const s = sessions().get(id);
  if (!s) return;
  sessions().delete(id);
  try {
    s.proc?.kill("SIGKILL");
  } catch {
    // process may already be gone
  }
  fs.promises.rm(s.dir, { recursive: true, force: true }).catch(() => {
    // best-effort cleanup
  });
}

// ---- idle reaper ----

function reap(): void {
  const now = Date.now();
  for (const s of sessions().values()) {
    const age = now - s.lastAccess;
    const terminal = s.status === "done" || s.status === "error";
    if (age > IDLE_TTL_MS || (terminal && age > TERMINAL_TTL_MS)) {
      stopSession(s.id);
    }
  }
}

/** Create the single idle-reaper interval (once per process). */
function ensureReaper(): void {
  const g = globalThis as GlobalWithSessions;
  if (g[REAPER_KEY]) return;
  g[REAPER_KEY] = true;
  const interval = setInterval(() => {
    try {
      reap();
    } catch (err) {
      console.error("[transcode] reaper failed:", err);
    }
  }, REAP_INTERVAL_MS);
  interval.unref();
}
