import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG_DIR } from "@/server/config/paths";
import { getSettings } from "@/server/settings/settings-service";

const execFileAsync = promisify(execFile);

// ---- tunables ----
const REAP_INTERVAL_MS = 30_000;
/** Reap any session not touched for this long, whatever its status. */
const IDLE_TTL_MS = 90_000;
/** Reap finished/failed sessions sooner once nobody is watching. */
const TERMINAL_TTL_MS = 30_000;
const STDERR_KEEP = 4_000; // cap captured stderr so a chatty run can't grow unbounded

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
}

export interface StartOpts {
  /** Seek offset (seconds) applied as an input `-ss` before the file is opened. */
  startSec?: number;
  /** 0-based audio-stream index to map (`0:a:index`). Defaults to the first track. */
  audioTrack?: number;
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
 * Input-side flags (must precede `-i`) that select the hardware decode path.
 * `device` is the DRM render node (`/dev/dri/renderD12x`); it pins VAAPI and QSV
 * to a specific GPU — essential when the host has more than one (e.g. a dedicated
 * transcode card alongside an AI card).
 */
function hwaccelInputArgs(mode: HwAccel, device: string): string[] {
  switch (mode) {
    case "vaapi":
      return [
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        device || "/dev/dri/renderD128",
        "-hwaccel_output_format",
        "vaapi",
      ];
    case "qsv":
      // `-qsv_device <render node>` pins QSV to a specific Intel GPU; omitting it
      // lets ffmpeg pick the default one.
      return device ? ["-qsv_device", device, "-hwaccel", "qsv"] : ["-hwaccel", "qsv"];
    case "nvenc":
      return ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
    case "none":
    default:
      return [];
  }
}

/** Output-side video encoder flags per hardware mode. */
function videoArgs(mode: HwAccel): string[] {
  switch (mode) {
    case "vaapi":
      return ["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", "23"];
    case "qsv":
      return ["-c:v", "h264_qsv", "-global_quality", "23"];
    case "nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"];
    case "none":
    default:
      return [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "21",
        "-maxrate",
        "8M",
        "-bufsize",
        "16M",
        "-pix_fmt",
        "yuv420p",
      ];
  }
}

/** Build the full ffmpeg argv for an HLS (mpegts, event) transcode. */
export function buildFfmpegArgs(
  absPath: string,
  dir: string,
  mode: HwAccel,
  vaapiDevice: string,
  startSec?: number,
  audioTrack?: number
): string[] {
  const seek = startSec && startSec > 0 ? ["-ss", String(startSec)] : [];
  const audioIndex = Number.isInteger(audioTrack) && audioTrack! >= 0 ? audioTrack! : 0;
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...hwaccelInputArgs(mode, vaapiDevice),
    ...seek,
    "-i",
    absPath,
    "-map",
    "0:v:0",
    "-map",
    `0:a:${audioIndex}?`,
    ...videoArgs(mode),
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "160k",
    "-sn",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_playlist_type",
    "event",
    "-hls_flags",
    "independent_segments",
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
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5_000 });
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
    await execFileAsync("ffmpeg", buildHwTestArgs(mode, vaapiDevice), { timeout: 25_000 });
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
        mode === "none"
          ? `Software encoding failed: ${detail}`
          : `${label} is not working — check the GPU is passed through to the container. (${detail})`,
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
export async function startSession(absPath: string, opts: StartOpts = {}): Promise<Session> {
  const settings = getSettings();
  const cap = settings.maxTranscodeSessions;
  if (activeCount() >= cap) throw new CapReachedError(cap);

  if (!(await ffmpegAvailable())) throw new FfmpegMissingError();

  ensureReaper();

  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(TRANSCODE_ROOT, id);

  const session: Session = {
    id,
    absPath,
    dir,
    proc: null,
    status: "starting",
    lastAccess: Date.now(),
  };
  sessions().set(id, session);

  try {
    fs.mkdirSync(dir, { recursive: true });

    const args = buildFfmpegArgs(
      absPath,
      dir,
      settings.transcodeHwAccel,
      settings.transcodeVaapiDevice,
      opts.startSec,
      opts.audioTrack
    );

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    session.proc = proc;
    session.status = "running";

    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_KEEP);
    });

    // A spawn failure (e.g. binary vanished after detection) must never crash the
    // process — surface it on the session instead.
    proc.on("error", (err) => {
      session.status = "error";
      session.error = err instanceof Error ? err.message : String(err);
    });

    proc.on("exit", (code) => {
      if (session.status === "error") return; // already flagged by 'error'
      if (code === 0) {
        session.status = "done";
      } else {
        session.status = "error";
        session.error = stderrTail.trim() || `ffmpeg exited with code ${code ?? "unknown"}`;
      }
    });

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
