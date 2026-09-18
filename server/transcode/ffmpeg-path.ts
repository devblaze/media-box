/**
 * Which ffmpeg and ffprobe to run.
 *
 * Overridable because the distribution's build is not always one that can drive
 * the hardware. Debian 12's ffmpeg links Intel's old Media SDK (libmfx 1.35),
 * which stops at 12th-generation integrated graphics and knows nothing about
 * Arc: on an A380 QSV dies with "Error initializing an MFX session" while VAAPI
 * encodes perfectly. The GPU is passed through correctly in that case — the
 * encoder library simply predates the card.
 *
 * Pointing these at a oneVPL build (jellyfin-ffmpeg, or a newer distribution's)
 * fixes QSV without rebuilding the image, which matters for anyone running
 * outside the published container.
 */
export const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";
