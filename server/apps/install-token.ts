import crypto from "node:crypto";
import { getSettings } from "@/server/settings/settings-service";

/**
 * Credentials for installing the app from a device that has no account yet.
 *
 * Scanning a QR code happens BEFORE the app exists on the phone, so the
 * download cannot sit behind a session. Instead each link carries a signed,
 * expiring token naming exactly one build, and TVs — which have no camera and a
 * miserable keyboard — get a short code that stands in for one.
 */

/** Long enough to walk to the TV; short enough that a photo of a QR code on a
 *  desk is not a permanent key to the server. */
export const INSTALL_TOKEN_TTL_MS = 30 * 60_000;

/**
 * Unambiguous alphabet for the typed code: no I/L/O/U, so nothing reads as a
 * digit and nothing spells anything. Six characters is ~1.07 billion codes,
 * which is a thousand times the space of the six DIGITS the shape of this
 * control invites, at no extra cost to whoever is typing it on a remote.
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

interface CodeEntry {
  buildId: string;
  expiresAt: number;
}

// Codes live in memory only: they are disposable, and a restart invalidating
// them is the correct behaviour rather than a loss.
const CODES_KEY = Symbol.for("mediabox.apps.installCodes");
type GlobalWithCodes = typeof globalThis & { [CODES_KEY]?: Map<string, CodeEntry> };

function codes(): Map<string, CodeEntry> {
  const g = globalThis as GlobalWithCodes;
  if (!g[CODES_KEY]) g[CODES_KEY] = new Map();
  return g[CODES_KEY];
}

/** The API key doubles as the signing secret — rotating it invalidates every
 *  outstanding install link, which is the behaviour an admin would expect. */
function sign(payload: string): string {
  return crypto.createHmac("sha256", getSettings().apiKey).update(payload).digest("base64url");
}

/** A token authorising the download of exactly one build, for a limited time. */
export function mintInstallToken(buildId: string, ttlMs: number = INSTALL_TOKEN_TTL_MS): string {
  const payload = `${buildId}.${Date.now() + ttlMs}`;
  return `${payload}.${sign(payload)}`;
}

/** The build a token authorises, or null if it is malformed, forged or expired. */
export function verifyInstallToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [buildId, expStr, sig] = parts;
  const expected = sign(`${buildId}.${expStr}`);
  // Compare in constant time, and only once the lengths match — timingSafeEqual
  // throws on a length mismatch, which would itself leak.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return buildId;
}

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function pruneCodes(): void {
  const now = Date.now();
  for (const [code, entry] of codes()) {
    if (entry.expiresAt <= now) codes().delete(code);
  }
}

/** A short, typeable stand-in for an install link, for devices with a remote
 *  instead of a camera. */
export function mintShortCode(
  buildId: string,
  ttlMs: number = INSTALL_TOKEN_TTL_MS
): { code: string; expiresAt: number } {
  pruneCodes();
  let code = randomCode();
  while (codes().has(code)) code = randomCode();
  const expiresAt = Date.now() + ttlMs;
  codes().set(code, { buildId, expiresAt });
  return { code, expiresAt };
}

/** The build a code stands for, or null when unknown or expired. Case- and
 *  whitespace-insensitive, because it was typed on a TV remote. */
export function resolveShortCode(code: string): string | null {
  pruneCodes();
  const entry = codes().get(code.trim().toUpperCase());
  return entry ? entry.buildId : null;
}
