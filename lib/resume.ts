/** Saved watch progress as returned by GET /api/v1/watch-progress. */
export interface SavedProgress {
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
}

/**
 * Where playback should resume from, in whole seconds — 0 means "from the top".
 * Mirrors the direct-player rules so both players behave identically: ignore
 * blips (≤5s) and near-finished positions (≥95% when the duration is known).
 * Used to START a transcode at the right offset (`startSec`), since an HLS
 * event playlist can't seek to unencoded time — client-side seeking there
 * silently clamps to what ffmpeg has produced, which is why resuming used to
 * restart transcoded titles from 0.
 */
export function resumeStartSeconds(progress: SavedProgress | null | undefined): number {
  if (!progress) return 0;
  const { positionSeconds, durationSeconds } = progress;
  if (positionSeconds <= 5) return 0;
  if (durationSeconds > 0 && positionSeconds >= durationSeconds * 0.95) return 0;
  return Math.floor(positionSeconds);
}
