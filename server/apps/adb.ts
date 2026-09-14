import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the `adb` command-line tool, used to push media-box's own
 * Android build onto an Android TV / Google TV / Fire TV across the LAN.
 *
 * Two rules shape the whole module:
 *
 *  - Every process is spawned with an ARGV ARRAY through {@link runAdb} — never a
 *    shell string, never interpolation into one. The host and the pairing code
 *    arrive from an admin-entered form field, and a shell string would hand that
 *    field a shell. {@link isValidHost} is the second half of that boundary.
 *  - The argv builders are PURE. What we actually ask adb to do is the part most
 *    worth pinning down in a test, and a pure builder can be asserted without a
 *    device, a network, or an adb binary anywhere near the test run.
 */

// ---- tunables ----

/** `adb version` talks to nothing — this only has to out-run a wedged PATH lookup. */
const VERSION_TIMEOUT_MS = 5_000;
/**
 * `adb connect` to a box that is powered off or firewalled sits in a TCP connect
 * until the OS gives up (~75 s on Linux), which would hold the HTTP request open
 * far longer than anyone is willing to stare at a spinner. 20 s is an order of
 * magnitude past a healthy LAN handshake and past a refused connection, so
 * cutting here only ever kills a hang.
 */
const CONNECT_TIMEOUT_MS = 20_000;
/**
 * Pairing adds a TLS handshake and a PIN exchange on top of the same round trip,
 * and it is the device — sitting in its "Pair with this device" dialog — that
 * sets the pace, so give it half again.
 */
const PAIR_TIMEOUT_MS = 30_000;
/**
 * A 60 MB APK over a mediocre 2.4 GHz link is minutes of transfer by itself, and
 * the device then runs its own verify/dexopt pass before adb prints anything at
 * all — on cheap Fire TV hardware that alone can be another minute. Four minutes
 * is deliberately generous: cutting a legitimate install short leaves a
 * half-installed app, while waiting a bit longer costs only a held connection.
 */
const INSTALL_TIMEOUT_MS = 240_000;
/** Cleanup must never become the thing that hangs the request. */
const DISCONNECT_TIMEOUT_MS = 10_000;
/** Cap what a single command contributes to the transcript so a chatty or
 *  looping adb can't grow the response without bound. */
const OUTPUT_KEEP = 4_000;

/** adb's TCP port. Wireless debugging always listens here once it is enabled;
 *  only the (ephemeral, per-session) PAIRING port differs. */
export const DEFAULT_ADB_PORT = 5555;

// ---- errors ----

/** Thrown when the `adb` binary is not on PATH. Distinct from a command that ran
 *  and failed, because the fix is completely different (install platform-tools). */
export class AdbUnavailableError extends Error {
  constructor() {
    super("adb is not installed on the server");
    this.name = "AdbUnavailableError";
  }
}

/**
 * Thrown when an adb invocation failed — carrying that command's own output, so
 * the UI can show the admin what the device actually said rather than a generic
 * "install failed". `transcript` is the whole session up to and including the
 * failure (populated by {@link installApk}).
 */
export class AdbCommandError extends Error {
  /** The command as displayed, e.g. `adb -s 10.0.0.2:5555 install -r app.apk`. */
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Every command run in this attempt, newline-separated. Filled in by installApk. */
  transcript: string;

  constructor(
    message: string,
    details: { command?: string; stdout?: string; stderr?: string; transcript?: string } = {}
  ) {
    super(message);
    this.name = "AdbCommandError";
    this.command = details.command ?? "adb";
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.transcript = details.transcript ?? "";
  }
}

// ---- validation (a security boundary, not a nicety) ----

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** One DNS label: alphanumeric, inner hyphens only. No leading `-` (adb would
 *  read it as a flag), no `_`, no `:`/`/`/`.`, no whitespace, nothing quotable. */
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * Is `host` something we are willing to hand to `adb`? Accepts an IPv4 literal
 * or a plain hostname/FQDN label chain and nothing else — in particular it
 * rejects an embedded port (`1.2.3.4:5555`), a scheme (`http://…`), a path
 * separator, a leading dash, and anything with whitespace or shell
 * metacharacters in it.
 *
 * execFile already makes shell metacharacters inert, but this is the rule that
 * keeps a typo or an attempted injection from reaching a process at all, and it
 * stops the two adb-specific footguns an argv array does NOT cover: a value
 * starting with `-` is parsed as an option, and a value with a colon in it
 * silently overrides the port we appended.
 *
 * IPv6 is deliberately not accepted: adb needs it bracketed (`[::1]:5555`) and
 * nothing in this feature has needed it yet.
 */
export function isValidHost(host: string): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (IPV4_RE.test(host)) return true;
  // Digits-and-dots that isn't a valid IPv4 (`10.0.0`, `999.1.1.1`, `1.2.3.4.5`)
  // is a mistyped address, never a hostname — a TLD is never all-numeric.
  if (/^[\d.]+$/.test(host)) return false;
  const labels = host.split(".");
  return labels.every((label) => label.length <= 63 && LABEL_RE.test(label));
}

/** A pairing code is exactly the six digits the TV shows. Enforced separately
 *  because a code of `--foo` would be read by adb as an option, not a password. */
function isValidPairCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

// ---- argv construction (pure) ----

/** `adb connect <host>:<port>` — the handshake that puts the device in
 *  `adb devices` under the serial `<host>:<port>`. */
export function buildConnectArgs(host: string, port: number): string[] {
  return ["connect", `${host}:${port}`];
}

/**
 * `adb -s <serial> install -r <apk>`.
 *
 * `-s` is a GLOBAL option and must precede the subcommand — `adb install -s …`
 * is a different (and wrong) command. Naming the serial matters even with one
 * device connected: a developer's phone plugged into the same server would
 * otherwise make adb refuse with "more than one device", or worse, pick it.
 *
 * `-r` reinstalls over an existing copy while keeping its data, which is what an
 * in-place upgrade of an already-installed media-box app needs; without it adb
 * fails with INSTALL_FAILED_ALREADY_EXISTS.
 */
export function buildInstallArgs(serial: string, apkPath: string): string[] {
  return ["-s", serial, "install", "-r", apkPath];
}

/** `adb pair <host>:<pairPort> <code>` — Android 11+ wireless debugging, where
 *  pairing happens on its own ephemeral port with a six-digit code and is a
 *  ONE-OFF: once paired, later installs only need connect. */
export function buildPairArgs(host: string, port: number, code: string): string[] {
  return ["pair", `${host}:${port}`, code];
}

/** `adb disconnect <serial>`. */
export function buildDisconnectArgs(serial: string): string[] {
  return ["disconnect", serial];
}

/** The serial adb files a network device under: literally `host:port`. */
export function deviceSerial(host: string, port: number): string {
  return `${host}:${port}`;
}

// ---- failure detection ----

/**
 * Markers (matched case-insensitively) that make an adb line a failure.
 *
 * This exists because adb's exit status cannot be trusted: `adb connect` has
 * long exited 0 while printing "failed to connect to '10.0.0.2:5555'", and
 * `adb install` prints the interesting half of its diagnosis on stdout
 * ("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]") regardless of status. We
 * therefore read the OUTPUT as the source of truth and treat the exit code as a
 * second opinion.
 *
 * The daemon banner adb prints on a cold start ("* daemon not running; starting
 * now at tcp:5037", "* daemon started successfully") goes to stderr and is NOT a
 * failure — no marker here may match it.
 */
const FAILURE_MARKERS = [
  "failed to connect",
  "unable to connect",
  "cannot connect to",
  "connection refused",
  "connection reset",
  "no route to host",
  "failed to authenticate",
  "unauthorized", // the "Allow USB debugging?" prompt was never accepted
  "device offline",
  "protocol fault",
  "adb: error:",
  "adb: failed to",
  "failure [", // Failure [INSTALL_FAILED_…]
  "failed:", // `adb pair` reports a wrong/expired code this way
  "more than one device",
  "no devices/emulators found",
  "device not found",
  "does not exist",
];

/**
 * The first line of `output` that says the command failed, or null if none does.
 *
 * Returning the LINE rather than a boolean is deliberate: that line is the whole
 * reason a human can tell "wrong pairing code" from "the TV's storage is full",
 * and it is what ends up in the error the UI shows.
 */
export function adbFailureReason(output: string): string | null {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    // adb's own convention for a fatal message is a line starting `error:`.
    if (lower.startsWith("error:")) return line;
    if (FAILURE_MARKERS.some((marker) => lower.includes(marker))) return line;
  }
  return null;
}

// ---- process boundary ----

interface AdbRun {
  /** stdout and stderr together. adb routinely splits one story across both
   *  streams, so both the transcript and failure detection want the pair. */
  output: string;
  stdout: string;
  stderr: string;
  /** Exit status, or null when the process was killed (timeout/signal). */
  code: number | null;
  timedOut: boolean;
}

type ExecFileError = Error & {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

function toRun(stdout: string, stderr: string, code: number | null, timedOut: boolean): AdbRun {
  const out = stdout.trim();
  const err = stderr.trim();
  return {
    stdout: out,
    stderr: err,
    output: [out, err].filter(Boolean).join("\n").slice(0, OUTPUT_KEEP),
    code,
    timedOut,
  };
}

/**
 * Run one adb command and come back with its output whatever happened — a
 * non-zero exit is DATA here, not an exception, because the caller needs the
 * failing command's output for the transcript either way. The single exception
 * is a missing binary, which is not a result at all.
 *
 * @throws {AdbUnavailableError} adb is not on PATH
 */
async function runAdb(args: string[], timeoutMs: number): Promise<AdbRun> {
  try {
    const { stdout, stderr } = await execFileAsync("adb", args, { timeout: timeoutMs });
    return toRun(stdout, stderr, 0, false);
  } catch (err) {
    const e = (err ?? {}) as ExecFileError;
    if (e.code === "ENOENT") throw new AdbUnavailableError();
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    let stderr = typeof e.stderr === "string" ? e.stderr : "";
    // A spawn-level failure (EACCES, and the timeout kill) produces no streams;
    // the Error's message is then the only thing worth showing.
    if (!stdout && !stderr) stderr = e.message || String(err);
    return toRun(stdout, stderr, typeof e.code === "number" ? e.code : null, e.killed === true);
  }
}

/**
 * Cheap feature-detect: does `adb version` run? Never throws.
 *
 * `version` specifically — `adb devices` would start the adb server as a side
 * effect (and block for seconds doing it), which is not what "is it installed?"
 * should cost.
 */
export async function adbAvailable(): Promise<boolean> {
  try {
    await execFileAsync("adb", ["version"], { timeout: VERSION_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

// ---- install ----

export interface InstallApkOptions {
  /** Hostname or IPv4 of the TV. Validated by {@link isValidHost}. */
  host: string;
  /** adb port; defaults to {@link DEFAULT_ADB_PORT}. */
  port?: number;
  /** Absolute path to the APK on the server. */
  apkPath: string;
  /** Android 11+ wireless debugging: the ephemeral pairing port shown on screen. */
  pairPort?: number;
  /** Android 11+ wireless debugging: the six-digit code shown on screen. */
  pairCode?: string;
}

/**
 * The command line as the transcript shows it. The APK is named but the
 * directory it was served from is not: where media-box keeps its builds is
 * server plumbing that tells the admin nothing useful about a failed install,
 * and this string is rendered verbatim in the UI.
 */
function displayCommand(args: string[]): string {
  return ["adb", ...args.map((a) => (a.endsWith(".apk") ? path.basename(a) : a))].join(" ");
}

/**
 * Install `apkPath` onto the device at `host`: optionally pair, connect, install,
 * and disconnect again no matter how that went.
 *
 * Resolves with a transcript of every command and its output, meant to be shown
 * to the admin verbatim — an adb failure is usually only diagnosable from the
 * exact words the device chose.
 *
 * @throws {AdbUnavailableError} adb is not installed
 * @throws {AdbCommandError} bad input, or any step that failed/timed out
 */
export async function installApk(
  opts: InstallApkOptions
): Promise<{ transcript: string; serial: string }> {
  const port = opts.port ?? DEFAULT_ADB_PORT;

  // Everything is validated BEFORE the first spawn, so a hostile value never
  // reaches a process even in the pair-then-fail path.
  if (!isValidHost(opts.host)) {
    throw new AdbCommandError(
      "That device address is not valid. Enter a hostname or IPv4 address on its own — no port, scheme or path."
    );
  }
  if (!isValidPort(port)) {
    throw new AdbCommandError("That adb port is not valid. Use a port between 1 and 65535.");
  }
  const pairing = opts.pairPort !== undefined || opts.pairCode !== undefined;
  if (pairing) {
    if (!isValidPort(opts.pairPort ?? NaN)) {
      throw new AdbCommandError(
        "That pairing port is not valid. Use the port shown under Wireless debugging → Pair device with pairing code."
      );
    }
    if (!isValidPairCode(opts.pairCode ?? "")) {
      throw new AdbCommandError("The pairing code must be the six digits shown on the device.");
    }
  }
  if (!opts.apkPath) throw new AdbCommandError("No APK was given to install.");

  const serial = deviceSerial(opts.host, port);
  const lines: string[] = [];
  const transcript = () => lines.join("\n").trimEnd();

  /** Run a step, record it, and turn "it didn't work" into a typed error. */
  const step = async (args: string[], timeoutMs: number, what: string): Promise<AdbRun> => {
    const run = await runAdb(args, timeoutMs);
    const command = displayCommand(args);
    lines.push(`$ ${command}`, run.output || "(no output)", "");
    const detail = { command, stdout: run.stdout, stderr: run.stderr };
    if (run.timedOut) {
      throw new AdbCommandError(
        `${what} timed out after ${Math.round(timeoutMs / 1000)}s — the device may be asleep or on another network.`,
        detail
      );
    }
    // Output first, status second: the output is what names the actual problem,
    // and for `adb connect` it is frequently the ONLY sign there was one.
    const reason = adbFailureReason(run.output);
    if (reason) throw new AdbCommandError(`${what} failed: ${reason}`, detail);
    if (run.code !== 0) {
      throw new AdbCommandError(`${what} failed (adb exited with ${run.code ?? "a signal"}).`, detail);
    }
    return run;
  };

  try {
    try {
      if (pairing) {
        // Pairing is a one-off per device: it exchanges a certificate, and its
        // port dies with the on-screen dialog. Later installs skip straight to
        // connect, which is why this stays optional.
        await step(
          buildPairArgs(opts.host, opts.pairPort as number, opts.pairCode as string),
          PAIR_TIMEOUT_MS,
          "Pairing with the device"
        );
      }
      await step(buildConnectArgs(opts.host, port), CONNECT_TIMEOUT_MS, "Connecting to the device");
      await step(
        buildInstallArgs(serial, opts.apkPath),
        INSTALL_TIMEOUT_MS,
        "Installing the app"
      );
    } finally {
      // Hand the connection back even when the install blew up: adb otherwise
      // keeps the device in its device list, where a later attempt finds it
      // stale/"offline" and refuses — leaving the admin to restart adb by hand.
      // Cleanup failures are recorded but never raised over the real error.
      const args = buildDisconnectArgs(serial);
      const run = await runAdb(args, DISCONNECT_TIMEOUT_MS).catch(() => null);
      if (run) lines.push(`$ ${displayCommand(args)}`, run.output || "(no output)", "");
    }
  } catch (err) {
    if (err instanceof AdbCommandError) err.transcript = transcript();
    throw err;
  }

  return { transcript: transcript(), serial };
}
