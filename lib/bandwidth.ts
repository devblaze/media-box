"use client";

/**
 * Measuring the link between this browser and the media-box server.
 *
 * Deliberately NOT `navigator.connection.downlink`: it describes the local
 * radio, not the route to this server, Chrome caps it at 10 Mbps, and Safari and
 * Firefox don't implement it at all. Trusting it would transcode a high-bitrate
 * file on a gigabit LAN.
 *
 * The player has to know, BEFORE it commits to a stream, whether the bytes can
 * actually arrive fast enough. `navigator.connection` only describes the first
 * hop — it says nothing about a slow uplink at the server, a VPN, or the wider
 * internet in between — so the real path gets measured directly: pull the head
 * of the file that is about to play and time how fast it lands.
 */

/** sessionStorage key holding the most recent measurement. */
const CACHE_KEY = "mediabox.linkKbps";
/** Measurements go stale — a network that was fine ten minutes ago proves nothing. */
const CACHE_TTL_MS = 5 * 60_000;
/** How long the sampling window runs once bytes start arriving. */
const SAMPLE_MS = 2_500;
/** Cap on bytes pulled, so a fast link ends the probe on volume rather than time. */
const PROBE_BYTES = 4 * 1024 * 1024;
/** Below this, the sample is too small to divide by. */
const MIN_SAMPLE_BYTES = 48 * 1024;
/** Give up entirely after this — includes waiting for the first byte. */
const PROBE_DEADLINE_MS = 8_000;

type CachedSpeed = { kbps: number; at: number };

/** The last measurement for this tab, or null when there is none or it is stale. */
export function cachedLinkKbps(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSpeed;
    if (!parsed || typeof parsed.kbps !== "number" || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed.kbps;
  } catch {
    return null;
  }
}

export function rememberLinkKbps(kbps: number): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ kbps, at: Date.now() } as CachedSpeed));
  } catch {
    /* storage disabled — the measurement just isn't reused */
  }
}

/**
 * Measure throughput by range-requesting the head of `url` and timing the bytes.
 *
 * Returns kbps, or null when the sample was too small to be meaningful (a tiny
 * file, or a link fast enough to finish before the clock got going) — callers
 * treat null as "unknown", not "slow". The download is aborted as soon as the
 * window closes, so the probe costs at most a couple of seconds of bandwidth.
 */
export async function measureLinkKbps(url: string): Promise<number | null> {
  if (typeof fetch === "undefined") return null;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PROBE_DEADLINE_MS);
  const requestedAt = performance.now();
  try {
    // Open-ended range: the probe stops on its own clock, and asking for a fixed
    // 4 MB would be unsatisfiable on any file shorter than that.
    const res = await fetch(url, {
      headers: { Range: "bytes=0-" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    let firstChunkAt = 0;
    let bytesAfterFirst = 0;
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      totalBytes += value.byteLength;
      if (firstChunkAt === 0) {
        // Start the clock on arrival, so a server that spends a second seeking
        // to the file doesn't get scored as a slow link.
        firstChunkAt = performance.now();
      } else {
        bytesAfterFirst += value.byteLength;
      }
      if (performance.now() - firstChunkAt >= SAMPLE_MS || totalBytes >= PROBE_BYTES) break;
    }
    // Stop pulling the rest of the range — this is a probe, not a download.
    await reader.cancel().catch(() => {});
    controller.abort();

    const now = performance.now();
    const sampleMs = firstChunkAt > 0 ? now - firstChunkAt : 0;
    // bytes·8 bits ÷ milliseconds is already kilobits per second.
    if (bytesAfterFirst >= MIN_SAMPLE_BYTES && sampleMs >= 250) {
      return (bytesAfterFirst * 8) / sampleMs;
    }
    // One big chunk (or one slow one): fall back to the whole request, which
    // charges the measurement for time-to-first-byte as well.
    const totalMs = now - requestedAt;
    if (totalBytes >= MIN_SAMPLE_BYTES && totalMs >= 250) {
      return (totalBytes * 8) / totalMs;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
