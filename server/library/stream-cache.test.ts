import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamCache, computeUnlimitedBudget, fileIdentity } from "./stream-cache";

const CHUNK = 1024; // tiny chunks so tests cross boundaries cheaply

let dir: string;
let filePath: string;
/** 10 chunks of predictable bytes: chunk i is filled with byte value i. */
const FILE_SIZE = 10 * CHUNK;

async function readAll(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

function expectedBytes(start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start + 1);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor((start + i) / CHUNK);
  return buf;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "stream-cache-"));
  filePath = path.join(dir, "movie.bin");
  const content = Buffer.alloc(FILE_SIZE);
  for (let i = 0; i < FILE_SIZE; i++) content[i] = Math.floor(i / CHUNK);
  await writeFile(filePath, content);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function identity() {
  return fileIdentity(filePath, FILE_SIZE, 12345);
}

describe("StreamCache.body", () => {
  it("serves exact bytes across chunk boundaries", async () => {
    const cache = new StreamCache(CHUNK);
    const got = await readAll(cache.body(identity(), 100, 3 * CHUNK + 7, 100 * CHUNK));
    expect(got.equals(expectedBytes(100, 3 * CHUNK + 7))).toBe(true);
  });

  it("serves a full file and a single-byte suffix", async () => {
    const cache = new StreamCache(CHUNK);
    const all = await readAll(cache.body(identity(), 0, FILE_SIZE - 1, 100 * CHUNK));
    expect(all.equals(expectedBytes(0, FILE_SIZE - 1))).toBe(true);
    const last = await readAll(cache.body(identity(), FILE_SIZE - 1, FILE_SIZE - 1, 100 * CHUNK));
    expect(last.equals(expectedBytes(FILE_SIZE - 1, FILE_SIZE - 1))).toBe(true);
  });

  it("serves correct bytes with the cache disabled-sized budget", async () => {
    const cache = new StreamCache(CHUNK);
    const got = await readAll(cache.body(identity(), 0, 2 * CHUNK - 1, 0));
    expect(got.equals(expectedBytes(0, 2 * CHUNK - 1))).toBe(true);
    expect(cache.stats().chunkCount).toBe(0); // nothing retained
  });
});

describe("caching behaviour", () => {
  it("hits RAM on repeat reads", async () => {
    const cache = new StreamCache(CHUNK);
    await cache.getChunk(identity(), 2, 100 * CHUNK);
    const before = cache.stats().diskReads;
    await cache.getChunk(identity(), 2, 100 * CHUNK);
    expect(cache.stats().diskReads).toBe(before);
  });

  it("dedupes concurrent reads of the same chunk", async () => {
    const cache = new StreamCache(CHUNK);
    await Promise.all([
      cache.getChunk(identity(), 5, 100 * CHUNK),
      cache.getChunk(identity(), 5, 100 * CHUNK),
      cache.getChunk(identity(), 5, 100 * CHUNK),
    ]);
    expect(cache.stats().diskReads).toBe(1);
  });

  it("evicts least-recently-used chunks beyond the budget", async () => {
    const cache = new StreamCache(CHUNK);
    const budget = 3 * CHUNK;
    for (const idx of [0, 1, 2, 3, 4]) await cache.getChunk(identity(), idx, budget);
    expect(cache.stats().totalBytes).toBeLessThanOrEqual(budget);
    expect(cache.stats().chunkCount).toBe(3);
    // 0 and 1 were evicted; re-reading 4 stays a RAM hit.
    const before = cache.stats().diskReads;
    await cache.getChunk(identity(), 4, budget);
    expect(cache.stats().diskReads).toBe(before);
    await cache.getChunk(identity(), 0, budget);
    expect(cache.stats().diskReads).toBe(before + 1);
  });

  it("treats a changed mtime as a different file", async () => {
    const cache = new StreamCache(CHUNK);
    await cache.getChunk(fileIdentity(filePath, FILE_SIZE, 111), 0, 100 * CHUNK);
    const before = cache.stats().diskReads;
    await cache.getChunk(fileIdentity(filePath, FILE_SIZE, 222), 0, 100 * CHUNK);
    expect(cache.stats().diskReads).toBe(before + 1);
  });
});

describe("prefetch", () => {
  it("pulls the whole file into RAM when the budget allows, then serves without disk I/O", async () => {
    const cache = new StreamCache(CHUNK);
    cache.notePosition(identity(), 0, 100 * CHUNK); // budget > file size
    // Prefetch runs in the background; poll briefly until it settles.
    for (let i = 0; i < 100 && cache.stats().chunkCount < 10; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cache.stats().chunkCount).toBe(10);
    // The whole file is resident — a full playback needs zero disk reads.
    const before = cache.stats().diskReads;
    const got = await readAll(cache.body(identity(), 0, FILE_SIZE - 1, 100 * CHUNK));
    expect(got.equals(expectedBytes(0, FILE_SIZE - 1))).toBe(true);
    expect(cache.stats().diskReads).toBe(before);
  });

  it("clamps the window to EOF", async () => {
    const cache = new StreamCache(CHUNK);
    cache.notePosition(identity(), FILE_SIZE - CHUNK, 100 * CHUNK);
    for (let i = 0; i < 50 && cache.stats().chunkCount < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cache.stats().chunkCount).toBe(1); // only the final chunk exists past that offset
  });
});

describe("computeUnlimitedBudget", () => {
  const GiB = 1024 * 1024 * 1024;

  it("grants free memory minus the 1 GiB headroom on small boxes", () => {
    expect(computeUnlimitedBudget(4 * GiB, 8 * GiB, 0)).toBe(3 * GiB);
  });

  it("uses a 10% headroom on big boxes", () => {
    // 64 GiB total -> headroom 6.4 GiB (> 1 GiB floor), floored to whole bytes.
    expect(computeUnlimitedBudget(32 * GiB, 64 * GiB, 0)).toBe(32 * GiB - Math.floor(6.4 * GiB));
  });

  it("counts bytes the cache already holds as available to it", () => {
    // Nearly all RAM used, but 3 GiB of it is ours — eviction can reclaim it.
    expect(computeUnlimitedBudget(0.5 * GiB, 8 * GiB, 3 * GiB)).toBe(2.5 * GiB);
  });

  it("never goes negative under memory pressure", () => {
    expect(computeUnlimitedBudget(0, 8 * GiB, 0)).toBe(0);
  });
});
