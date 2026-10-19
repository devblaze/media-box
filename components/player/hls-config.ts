// Type-only import: the runtime class is loaded with a dynamic `import("hls.js")`
// inside the player, so it's code-split out of the main bundle and never
// evaluated during SSR.
import type { HlsConfig, LoadPolicy } from "hls.js";

/** Retry with growing waits instead of hls.js's give-up-fast defaults. */
function patient(
  firstByteMs: number,
  loadMs: number,
  retries: { timeout: number; error: number },
  errorBackoff: "linear" | "exponential"
): LoadPolicy {
  return {
    default: {
      maxTimeToFirstByteMs: firstByteMs,
      maxLoadTimeMs: loadMs,
      timeoutRetry: {
        maxNumRetry: retries.timeout,
        retryDelayMs: 1_000,
        maxRetryDelayMs: 8_000,
        backoff: "linear",
      },
      errorRetry: {
        maxNumRetry: retries.error,
        retryDelayMs: 1_000,
        maxRetryDelayMs: 8_000,
        backoff: errorBackoff,
      },
    },
  };
}

/**
 * hls.js settings for media-box's on-demand transcode.
 *
 * `startPosition` matters most for seeking. Without it hls.js loads from 0:00 and
 * is only moved to the resume point after the first segment has played, and on
 * an on-demand transcode that means ffmpeg encodes the opening segment, gets
 * restarted at the resume point, and the viewer waits for both.
 */
export function transcodeHlsConfig(startPosition: number): Partial<HlsConfig> {
  return {
    enableWorker: true,
    startPosition: startPosition > 0 ? startPosition : -1,
    // Buffer the transcode generously when segments are available, so a slow
    // encoder that briefly falls behind doesn't starve playback. The back buffer
    // keeps the last minute and a half, so skipping back is served from memory.
    maxBufferLength: 60,
    maxMaxBufferLength: 600,
    maxBufferSize: 200 * 1000 * 1000,
    backBufferLength: 90,
    // Segments of one title can come from different ffmpeg runs (each seek away
    // from what's encoded restarts it), and the seam between two runs can leave a
    // hairline gap in the buffer. Step over gaps that small instead of stalling
    // on them, and notice a stuck playhead after one second rather than two.
    maxBufferHole: 0.5,
    highBufferWatchdogPeriod: 1,
    nudgeMaxRetry: 5,
    // Segments are encoded ON DEMAND, so the first byte of one the encoder hasn't
    // reached yet can be twenty seconds away, and down a weak link the segment
    // then takes far longer to arrive than hls.js's defaults (10 s to first byte)
    // allow. Those defaults turn a slow connection into a dead stream: every
    // fragment times out, the retries run out, and the player reports a failure
    // that was only ever slowness. Wait it out, with backoff, instead.
    fragLoadPolicy: patient(30_000, 300_000, { timeout: 6, error: 8 }, "exponential"),
    playlistLoadPolicy: patient(20_000, 60_000, { timeout: 4, error: 4 }, "linear"),
  };
}
