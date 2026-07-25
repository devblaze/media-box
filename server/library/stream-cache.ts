import { open } from "node:fs/promises";

/**
 * In-RAM read-ahead cache for direct-play streaming.
 *
 * Media files live on slow storage (HDD arrays behind Unraid's FUSE layer, with
 * spin-ups and parity latency); serving 64 KiB reads straight off them stutters.
 * This cache reads files in large chunks, keeps them in an LRU bounded by the
 * `streamRamCacheMb` setting, and runs a background prefetcher that stays a full
 * budget ahead of the newest read position — so with a budget larger than the
 * file, the whole movie ends up in RAM shortly after playback starts.
 *
 * One global cache serves all files/viewers; the byte budget is passed per call
 * (it's a live setting). Chunks are keyed by path+size+mtime, so a replaced or
 * regrown file never serves stale bytes.
 */

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

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

  constructor(readonly chunkBytes = DEFAULT_CHUNK_BYTES) {}

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
   * running ahead of it — up to a full budget ahead (clamped to EOF). Playback
   * naturally re-notes as it advances, so the window rolls with the viewer.
   */
  notePosition(file: CachedFile, offset: number, budgetBytes: number): void {
    if (budgetBytes <= 0 || file.size === 0) return;
    const lastIdx = Math.floor((file.size - 1) / this.chunkBytes);
    const posIdx = Math.min(Math.floor(offset / this.chunkBytes), lastIdx);
    const goalIdx = Math.min(
      posIdx + Math.max(1, Math.floor(budgetBytes / this.chunkBytes)) - 1,
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
