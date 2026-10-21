import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";

/**
 * In-RAM read-ahead cache for direct-play streaming.
 *
 * Media files live on slow storage (HDD arrays behind Unraid's FUSE layer, with
 * spin-ups and parity latency); serving 64 KiB reads straight off them stutters.
 * This cache reads files in large chunks, keeps them in an LRU bounded by the
 * `streamRamCacheMb` setting, and runs a background prefetcher that stays up to
 * {@link READ_AHEAD_BYTES} ahead of the newest read position.
 *
 * The read-ahead used to be the whole budget. With a big budget and a 4K remux
 * (60 GB) that meant tens of gigabytes pulled off the array at full speed into
 * RAM the moment playback began — enough to stall Unraid's shfs and starve the
 * box of memory. A gigabyte is over a minute even at remux bitrates: plenty to
 * ride out a disk spinning up. The budget still decides how much is KEPT, so
 * jumping back to something already watched stays free.
 *
 * One global cache serves all files/viewers; the byte budget is passed per call
 * (it's a live setting). Chunks are keyed by path+size+mtime, so a replaced or
 * regrown file never serves stale bytes.
 */

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
/** How far ahead of the viewer the prefetcher reads. */
export const READ_AHEAD_BYTES = 1024 * 1024 * 1024;
/**
 * The most of the machine's RAM the cache may ever hold, however it's set. On
 * Unraid the OS itself lives in RAM, and the page cache in "free" memory is what
 * keeps the array responsive: handing all of it to one movie is how a box hangs.
 */
const MAX_RAM_SHARE = 0.4;
const GiB = 1024 * 1024 * 1024;

/** What the cache can see of memory: the machine's, and the container's limit if any. */
export interface MemoryView {
  totalBytes: number;
  freeBytes: number;
  /** Bytes the cache holds now: its own eviction frees them, so they count as room. */
  heldBytes: number;
  /** A container memory limit and current usage (cgroup), when one is set. */
  cgroup: { limitBytes: number; usageBytes: number } | null;
}

/**
 * The budget the cache may actually use: what was asked for (Infinity for the
 * "unlimited" mode), but never more than {@link MAX_RAM_SHARE} of the RAM it may
 * use, and never into a safety headroom (the larger of 1 GiB or 10%). A container
 * memory limit counts as the RAM there is — the host's free memory says nothing
 * about how close the container is to being killed. Pure, for tests.
 */
export function computeSafeBudget(requestedBytes: number, mem: MemoryView): number {
  const limit = mem.cgroup ? Math.min(mem.cgroup.limitBytes, mem.totalBytes) : mem.totalBytes;
  const free = mem.cgroup
    ? Math.min(mem.freeBytes, mem.cgroup.limitBytes - mem.cgroup.usageBytes)
    : mem.freeBytes;
  const headroom = Math.max(GiB, Math.floor(limit * 0.1));
  const room = Math.max(0, free + mem.heldBytes - headroom);
  return Math.max(0, Math.min(requestedBytes, room, Math.floor(limit * MAX_RAM_SHARE)));
}

/** A number from a cgroup file, or null ("max", absent, or a no-limit sentinel). */
function readCgroupNumber(file: string): number | null {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const n = Number(raw);
    // cgroup v1 reports "no limit" as a huge page-aligned number.
    return Number.isFinite(n) && n > 0 && n < 2 ** 60 ? n : null;
  } catch {
    return null;
  }
}

/** The container's memory limit and usage (cgroup v2, else v1), or null when unlimited. */
function cgroupMemory(): MemoryView["cgroup"] {
  const limit =
    readCgroupNumber("/sys/fs/cgroup/memory.max") ??
    readCgroupNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (limit == null) return null;
  const usage =
    readCgroupNumber("/sys/fs/cgroup/memory.current") ??
    readCgroupNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes") ??
    0;
  return { limitBytes: limit, usageBytes: usage };
}

/** {@link computeSafeBudget} against this machine, right now. */
export function safeBudgetBytes(requestedBytes: number, heldBytes: number): number {
  return computeSafeBudget(requestedBytes, {
    totalBytes: os.totalmem(),
    freeBytes: os.freemem(),
    heldBytes,
    cgroup: cgroupMemory(),
  });
}

/** Identity of one on-disk file version. Build via `fileIdentity()`. */
export interface CachedFile {
  absPath: string;
  size: number;
  /** Cache key: path + size + mtime — any change invalidates naturally. */
  key: string;
}

export function fileIdentity(absPath: string, size: number, mtimeMs: number): CachedFile {
  return { absPath, size, key: `${absPath}|${size}|${mtimeMs}` };
}

interface PrefetchState {
  nextIdx: number;
  goalIdx: number;
  running: boolean;
}

export class StreamCache {
  /** Insertion order doubles as LRU order (delete + re-set bumps to newest). */
  private chunks = new Map<string, Buffer>();
  private inFlight = new Map<string, Promise<Buffer>>();
  private prefetch = new Map<string, PrefetchState>();
  private totalBytes = 0;
  private diskReads = 0;

  constructor(
    readonly chunkBytes = DEFAULT_CHUNK_BYTES,
    readonly readAheadBytes = READ_AHEAD_BYTES
  ) {}

  stats() {
    return { totalBytes: this.totalBytes, chunkCount: this.chunks.size, diskReads: this.diskReads };
  }

  clear() {
    this.chunks.clear();
    this.prefetch.clear();
    this.totalBytes = 0;
  }

  private chunkKey(file: CachedFile, idx: number): string {
    return `${file.key}#${idx}`;
  }

  private evictTo(budgetBytes: number) {
    for (const [key, buf] of this.chunks) {
      if (this.totalBytes <= budgetBytes) break;
      this.chunks.delete(key);
      this.totalBytes -= buf.length;
    }
  }

  private async readFromDisk(file: CachedFile, idx: number): Promise<Buffer> {
    this.diskReads++;
    const start = idx * this.chunkBytes;
    const length = Math.min(this.chunkBytes, file.size - start);
    if (length <= 0) return Buffer.alloc(0);
    const handle = await open(file.absPath, "r");
    try {
      const buf = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buf, read, length - read, start + read);
        if (bytesRead === 0) break; // file shrank underneath us
        read += bytesRead;
      }
      return read === length ? buf : buf.subarray(0, read);
    } finally {
      await handle.close();
    }
  }

  /**
   * The chunk at `idx`, from RAM when cached, deduping concurrent disk reads.
   * With `budgetBytes` 0 the cache is a pass-through (large reads, no retention).
   */
  async getChunk(file: CachedFile, idx: number, budgetBytes: number): Promise<Buffer> {
    const key = this.chunkKey(file, idx);
    const hit = this.chunks.get(key);
    if (hit) {
      this.chunks.delete(key);
      this.chunks.set(key, hit); // LRU bump
      return hit;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const task = this.readFromDisk(file, idx).then(
      (buf) => {
        this.inFlight.delete(key);
        if (buf.length > 0 && budgetBytes > 0 && buf.length <= budgetBytes) {
          this.chunks.set(key, buf);
          this.totalBytes += buf.length;
          this.evictTo(budgetBytes);
        }
        return buf;
      },
      (err) => {
        this.inFlight.delete(key);
        throw err;
      }
    );
    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Note the newest byte the player consumed and keep the background prefetcher
   * running ahead of it — up to the read-ahead window or the budget, whichever is
   * smaller (clamped to EOF). Playback naturally re-notes as it advances, so the
   * window rolls with the viewer.
   */
  notePosition(file: CachedFile, offset: number, budgetBytes: number): void {
    if (budgetBytes <= 0 || file.size === 0) return;
    const lastIdx = Math.floor((file.size - 1) / this.chunkBytes);
    const posIdx = Math.min(Math.floor(offset / this.chunkBytes), lastIdx);
    const windowBytes = Math.min(budgetBytes, this.readAheadBytes);
    const goalIdx = Math.min(
      posIdx + Math.max(1, Math.floor(windowBytes / this.chunkBytes)) - 1,
      lastIdx
    );

    let state = this.prefetch.get(file.key);
    if (!state) {
      state = { nextIdx: posIdx, goalIdx, running: false };
      this.prefetch.set(file.key, state);
    } else {
      state.goalIdx = Math.max(state.goalIdx, goalIdx);
      // A forward seek jumps the prefetcher; chunks behind stay cached anyway.
      if (state.nextIdx < posIdx) state.nextIdx = posIdx;
    }
    if (!state.running) {
      state.running = true;
      void this.runPrefetch(file, state, budgetBytes);
    }
  }

  private async runPrefetch(file: CachedFile, state: PrefetchState, budgetBytes: number) {
    try {
      while (state.nextIdx <= state.goalIdx) {
        await this.getChunk(file, state.nextIdx, budgetBytes);
        state.nextIdx++;
      }
    } catch {
      // Disk error mid-prefetch: stop quietly; the foreground read will surface it.
    } finally {
      state.running = false;
      // The map only grows by one entry per distinct file version; drop finished
      // states so replaced files don't accumulate.
      if (state.nextIdx > state.goalIdx) this.prefetch.delete(file.key);
    }
  }

  /**
   * A Web ReadableStream serving bytes [start, end] (inclusive) through the
   * cache. Each pull emits one chunk-slice and rolls the read-ahead window.
   */
  body(file: CachedFile, start: number, end: number, budgetBytes: number): ReadableStream {
    let offset = start;
    this.notePosition(file, start, budgetBytes);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const cache = this;
    return new ReadableStream({
      async pull(controller) {
        if (offset > end) {
          controller.close();
          return;
        }
        const idx = Math.floor(offset / cache.chunkBytes);
        const chunk = await cache.getChunk(file, idx, budgetBytes);
        const chunkStart = idx * cache.chunkBytes;
        const from = offset - chunkStart;
        if (from >= chunk.length) {
          // File shrank underneath us — end the stream early.
          controller.close();
          return;
        }
        const to = Math.min(chunk.length, end - chunkStart + 1);
        controller.enqueue(new Uint8Array(chunk.subarray(from, to)));
        offset = chunkStart + to;
        cache.notePosition(file, offset, budgetBytes);
      },
    });
  }
}

// One process-wide cache (Symbol-keyed on globalThis so it survives HMR).
const CACHE_KEY = Symbol.for("mediabox.streamCache");

type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: StreamCache };

export function getStreamCache(): StreamCache {
  const g = globalThis as GlobalWithCache;
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new StreamCache();
  return g[CACHE_KEY];
}
