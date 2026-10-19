"use client";

/**
 * Per-browser player preferences, kept in localStorage. Every read and write is
 * guarded: storage can be disabled or full, and then the choice simply isn't
 * remembered — playback never depends on it.
 */

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage disabled — the choice just isn't remembered */
  }
}

// "Always transcode" escape hatch. Direct play can be silent when a file's audio
// codec (e.g. AC3/DTS) isn't decodable by this browser — which isn't a <video>
// error, so it can't auto-recover. Forcing transcode re-encodes audio to stereo
// AAC (universally playable). Remembered for the device.
const FORCE_TRANSCODE_KEY = "mediabox.forceTranscode";

export function loadForceTranscode(): boolean {
  return read(FORCE_TRANSCODE_KEY) === "1";
}

export function saveForceTranscode(on: boolean): void {
  write(FORCE_TRANSCODE_KEY, on ? "1" : null);
}

// Stream-quality choice: "auto" (follow the measured link speed) or a rung id
// from the ladder. Per browser, because what it really describes — how good this
// device's connection to the server is — doesn't change between titles.
const QUALITY_PREF_KEY = "mediabox.streamQuality";
export const AUTO_QUALITY = "auto";

export function loadQualityPref(): string {
  return read(QUALITY_PREF_KEY) || AUTO_QUALITY;
}

export function saveQualityPref(value: string): void {
  write(QUALITY_PREF_KEY, value === AUTO_QUALITY ? null : value);
}

// Volume and mute, so every title doesn't open at full blast.
const VOLUME_KEY = "mediabox.volume";

export type VolumePref = { volume: number; muted: boolean };

export function loadVolumePref(): VolumePref {
  const raw = read(VOLUME_KEY);
  if (!raw) return { volume: 1, muted: false };
  try {
    const parsed = JSON.parse(raw) as Partial<VolumePref>;
    const volume = typeof parsed.volume === "number" ? Math.max(0, Math.min(1, parsed.volume)) : 1;
    return { volume, muted: parsed.muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

export function saveVolumePref(pref: VolumePref): void {
  write(VOLUME_KEY, pref.volume === 1 && !pref.muted ? null : JSON.stringify(pref));
}
