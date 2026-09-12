/**
 * The bitrate rungs a transcode session can be pinned to, best first.
 *
 * media-box encodes ONE rendition per session (the playlist carries no ABR
 * ladder), so the rung has to be chosen up front — from the measured speed of
 * the link between this browser and the server — and re-chosen, by restarting
 * the session, when playback can't keep up. Every rung caps the picture size as
 * well as the bitrate: a link that can't carry 8 Mbps can't carry watchable
 * 1080p at any bitrate, and encoding fewer pixels is what makes the low rungs
 * look acceptable.
 *
 * Shared by the client (menu + auto-selection) and the server (ffmpeg args), so
 * this module must stay free of node/browser-only imports.
 */
export interface TranscodeQuality {
  /** Stable id, sent as `quality` to `POST /api/v1/transcode`. */
  id: string;
  /** Menu label. */
  label: string;
  /** Ceiling on output height — the source is only ever scaled DOWN. */
  height: number;
  /** Video bitrate ceiling, kbps. */
  videoKbps: number;
  /** AAC bitrate, kbps. */
  audioKbps: number;
}

/** Best → worst. The first rung is the default and reproduces the legacy encode. */
export const TRANSCODE_QUALITIES: readonly TranscodeQuality[] = [
  { id: "max", label: "Best · 1080p", height: 1080, videoKbps: 8000, audioKbps: 160 },
  { id: "high", label: "1080p · 4 Mbps", height: 1080, videoKbps: 4000, audioKbps: 128 },
  { id: "medium", label: "720p · 2 Mbps", height: 720, videoKbps: 2000, audioKbps: 128 },
  { id: "low", label: "480p · 1 Mbps", height: 480, videoKbps: 1000, audioKbps: 96 },
  { id: "minimal", label: "360p · 0.5 Mbps", height: 360, videoKbps: 500, audioKbps: 64 },
];

export const DEFAULT_TRANSCODE_QUALITY = TRANSCODE_QUALITIES[0];
export const LOWEST_TRANSCODE_QUALITY = TRANSCODE_QUALITIES[TRANSCODE_QUALITIES.length - 1];

/**
 * How much of a measured link we are willing to fill. The rest is headroom for
 * the throughput dropping below what the probe saw — which on a bad connection
 * it constantly does.
 */
export const USABLE_LINK_FRACTION = 0.7;

/** Resolve a rung id; unknown or missing ids fall back to the default (best) rung. */
export function transcodeQuality(id: string | null | undefined): TranscodeQuality {
  return TRANSCODE_QUALITIES.find((q) => q.id === id) ?? DEFAULT_TRANSCODE_QUALITY;
}

/** Total stream bitrate of a rung (video + audio), kbps. */
export function qualityTotalKbps(q: TranscodeQuality): number {
  return q.videoKbps + q.audioKbps;
}

/** Position in the ladder: 0 = best. -1 for an unknown id. */
export function qualityRank(id: string): number {
  return TRANSCODE_QUALITIES.findIndex((q) => q.id === id);
}

/**
 * How much of the measured link a rung must fit inside before auto will step UP
 * to it. Deliberately tighter than {@link USABLE_LINK_FRACTION}, which is what
 * keeps auto where it is: the gap between the two is the hysteresis band that
 * stops a connection wobbling across one threshold from restarting the stream
 * over and over.
 */
export const STEP_UP_LINK_FRACTION = 0.5;

/** The next rung up, or null when already at the top. */
export function higherQuality(id: string): TranscodeQuality | null {
  const i = qualityRank(id);
  if (i <= 0) return null;
  return TRANSCODE_QUALITIES[i - 1] ?? null;
}

/** Whether a link measured at `linkKbps` has the headroom to move up to `q`. */
export function canStepUpTo(q: TranscodeQuality, linkKbps: number | null): boolean {
  if (linkKbps == null || linkKbps <= 0) return false;
  return qualityTotalKbps(q) <= linkKbps * STEP_UP_LINK_FRACTION;
}

/** The next rung down, or null when already at the bottom. */
export function lowerQuality(id: string): TranscodeQuality | null {
  const i = qualityRank(id);
  if (i < 0) return TRANSCODE_QUALITIES[1] ?? null;
  return TRANSCODE_QUALITIES[i + 1] ?? null;
}

/** True when a stream of `streamKbps` fits down a link measured at `linkKbps`. */
export function linkCanCarry(streamKbps: number, linkKbps: number | null): boolean {
  if (linkKbps == null || linkKbps <= 0) return true; // unmeasured → don't second-guess
  return streamKbps <= linkKbps * USABLE_LINK_FRACTION;
}

/**
 * The best rung a link measured at `linkKbps` can actually sustain. An unknown
 * speed keeps today's behaviour (the top rung); a link too slow for even the
 * bottom rung still gets the bottom rung — something playable beats nothing.
 */
export function qualityForLinkKbps(linkKbps: number | null): TranscodeQuality {
  if (linkKbps == null || linkKbps <= 0) return DEFAULT_TRANSCODE_QUALITY;
  return (
    TRANSCODE_QUALITIES.find((q) => linkCanCarry(qualityTotalKbps(q), linkKbps)) ??
    LOWEST_TRANSCODE_QUALITY
  );
}

/** "6.4 Mbps" / "820 kbps" — for the quality menu's connection caption. */
export function formatKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}
