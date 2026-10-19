import type { Neighbor } from "./types";

/** Two-digit zero-padded number, e.g. 3 → "03". */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Playback clock, e.g. 75 → "1:15", 3675 → "1:01:15". */
export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** e.g. 0 → "0.0s", 0.5 → "+0.5s", -0.3 → "-0.3s". */
export function formatOffset(sec: number): string {
  return `${sec > 0 ? "+" : ""}${sec.toFixed(1)}s`;
}

/** A seek burst's running total, e.g. 30 → "+30s", -70 → "−1:10". */
export function formatSkip(deltaSeconds: number): string {
  const d = Math.round(deltaSeconds);
  const sign = d < 0 ? "−" : "+";
  const abs = Math.abs(d);
  return abs < 60 ? `${sign}${abs}s` : `${sign}${fmtClock(abs)}`;
}

/** Human label for a neighbor, e.g. "Show · S01E02 · The Title". */
export function neighborLabel(n: Neighbor): string {
  return `${n.seriesTitle} · S${pad2(n.seasonNumber)}E${pad2(n.episodeNumber)}${
    n.title ? ` · ${n.title}` : ""
  }`;
}

/**
 * Coarse quality tag derived from a raw pixel height. Used only as a fallback
 * chip label when the versions list could not be fetched.
 */
export function qualityTagFromHeight(height: number | null | undefined): string | null {
  if (height == null) return null;
  if (height >= 2160) return "4K";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return "SD";
}
