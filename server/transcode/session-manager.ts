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

/** Input-side flags (must precede `-i`) that select the hardware decode path. */
function hwaccelInputArgs(mode: HwAccel, vaapiDevice: string): string[] {
  switch (mode) {
    case "vaapi":
      return [
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        vaapiDevice || "/dev/dri/renderD128",
        "-hwaccel_output_format",
        "vaapi",
      ];
    case "qsv":
      return ["-hwaccel", "qsv"];
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
  startSec?: number
): string[] {
  const seek = startSec && startSec > 0 ? ["-ss", String(startSec)] : [];
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
    "0:a:0?",
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
      opts.startSec
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
