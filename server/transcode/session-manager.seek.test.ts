import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_TRANSCODE_QUALITY } from "@/lib/transcode-quality";
import { ensureSegment, stopSession, type Session } from "./session-manager";

// No real ffmpeg: record each spawn's argv and hand back an inert process. A test
// "encodes" a segment by writing its file.
const { spawned } = vi.hoisted(() => ({ spawned: [] as string[][] }));
vi.mock("node:child_process", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    spawned.push(args);
    const proc = Object.assign(new EventEmitter(), { kill: () => true, stderr: new EventEmitter() });
    return proc;
  }),
  execFile: vi.fn(),
}));
vi.mock("@/server/settings/settings-service", () => ({
  getSettings: () => ({ transcodeHwAccel: "none", transcodeVaapiDevice: "", maxTranscodeSessions: 2 }),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Longer than the restart debounce, so a pending restart has fired (or not) by then. */
const SETTLE_MS = 400;

let dir = "";
const made: Session[] = [];

beforeEach(() => {
  spawned.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-seek-"));
});
afterEach(() => {
  for (const s of made.splice(0)) stopSession(s.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A running session, registered the way startSession does it (a restart checks). */
function session(over: Partial<Session> = {}): Session {
  const s: Session = {
    id: `s${made.length}-${Date.now()}`,
    absPath: "/media/film.mkv",
    dir,
    proc: null,
    status: "running",
    lastAccess: Date.now(),
    durationSec: 7200,
    segmentCount: 1800,
    audioTrack: null,
    encoderStart: 0,
    runStartedAt: Date.now(),
    runFrontier: -1,
    quality: DEFAULT_TRANSCODE_QUALITY,
    ...over,
  };
  const registry = globalThis as unknown as Record<symbol, Map<string, Session> | undefined>;
  const key = Symbol.for("mediabox.transcode.sessions");
  (registry[key] ??= new Map()).set(s.id, s);
  made.push(s);
  return s;
}

function write(i: number, mtime?: Date): void {
  const file = path.join(dir, `seg${String(i).padStart(5, "0")}.ts`);
  fs.writeFileSync(file, "ts");
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

/** The `-start_number` of every ffmpeg run spawned so far. */
const restarts = () => spawned.map((args) => args[args.indexOf("-start_number") + 1]);

describe("ensureSegment under seeking", () => {
  test("a burst of seeks restarts ffmpeg once, at the last target", async () => {
    const s = session();
    const first = new AbortController();
    const second = new AbortController();
    const p1 = ensureSegment(s, 100, first.signal);
    const p2 = ensureSegment(s, 200, second.signal);
    const p3 = ensureSegment(s, 300);
    await sleep(SETTLE_MS);
    expect(restarts()).toEqual(["300"]);

    first.abort();
    second.abort();
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    write(300);
    expect(await p3).toBe(true);
  });

  test("a seek back to what an earlier run wrote is served without a restart", async () => {
    const s = session({ encoderStart: 10, runFrontier: 9 });
    for (let i = 10; i <= 20; i++) write(i);
    const far = ensureSegment(s, 500);
    await sleep(SETTLE_MS);
    expect(restarts()).toEqual(["500"]);

    expect(await ensureSegment(s, 15)).toBe(true);
    expect(restarts()).toEqual(["500"]);
    write(500);
    expect(await far).toBe(true);
  });

  test("an abandoned request cancels the restart it asked for", async () => {
    const s = session();
    const gone = new AbortController();
    const p = ensureSegment(s, 400, gone.signal);
    gone.abort();
    expect(await p).toBe(false);
    await sleep(SETTLE_MS);
    expect(spawned).toHaveLength(0);
  });

  test("a request riding a pending restart keeps it alive when the one that asked goes away", async () => {
    const s = session();
    const gone = new AbortController();
    const asked = ensureSegment(s, 400, gone.signal);
    const rider = ensureSegment(s, 401);
    gone.abort();
    expect(await asked).toBe(false);
    await sleep(SETTLE_MS);
    expect(restarts()).toEqual(["400"]);
    write(401);
    expect(await rider).toBe(true);
  });

  test("segments an earlier run left ahead don't count as the new run's progress", async () => {
    // An earlier run wrote 300–340 an hour ago; this run started at 292 and has
    // written 292–295. It is at 296, not 340, so 341 is a seek, not a short wait.
    const hourAgo = new Date(Date.now() - 3_600_000);
    for (let i = 300; i <= 340; i++) write(i, hourAgo);
    const s = session({ encoderStart: 292, runFrontier: 291, runStartedAt: Date.now() - 100 });
    for (let i = 292; i <= 295; i++) write(i);

    const gone = new AbortController();
    const p = ensureSegment(s, 341, gone.signal);
    await sleep(SETTLE_MS);
    expect(restarts()).toEqual(["341"]);
    gone.abort();
    await p;
  });

  test("a near seek restarts when the encoder is too slow to get there soon", async () => {
    // Ten segments in twenty seconds: 2× realtime. Segment 20 is eleven ahead —
    // 22 s of waiting at that pace, against a couple of seconds for a restart.
    const s = session({ runStartedAt: Date.now() - 20_000 });
    for (let i = 0; i <= 9; i++) write(i);
    const gone = new AbortController();
    const p = ensureSegment(s, 20, gone.signal);
    await sleep(SETTLE_MS);
    expect(restarts()).toEqual(["20"]);
    gone.abort();
    await p;
  });

  test("a near seek waits for an encoder that will get there soon", async () => {
    // Ten segments in two seconds: 20× realtime, so three ahead is well under a second.
    const s = session({ runStartedAt: Date.now() - 2_000 });
    for (let i = 0; i <= 9; i++) write(i);
    const p = ensureSegment(s, 12);
    await sleep(SETTLE_MS);
    expect(spawned).toHaveLength(0);
    write(12);
    expect(await p).toBe(true);
  });

  test("a run that has only just started isn't judged on its pace", async () => {
    const s = session({ runStartedAt: Date.now() - 10_000 });
    write(0);
    const p = ensureSegment(s, 8);
    await sleep(SETTLE_MS);
    expect(spawned).toHaveLength(0);
    write(8);
    expect(await p).toBe(true);
  });

  test("a session stopped while a restart is pending never spawns ffmpeg", async () => {
    const s = session();
    const gone = new AbortController();
    const p = ensureSegment(s, 400, gone.signal);
    stopSession(s.id);
    await sleep(SETTLE_MS);
    expect(spawned).toHaveLength(0);
    gone.abort();
    await p;
  });
});
