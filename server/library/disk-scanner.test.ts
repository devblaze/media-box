/**
 * Covers the exported pure-ish pieces of the disk scanner: `VIDEO_EXTENSIONS`
 * and `walkVideoFiles` (against a throwaway temp tree; the ≥10 MB minimum-size
 * rule is exercised with sparse files, which cost no real disk).
 *
 * `normalizeTitleText` / `matchEpisodeByTitle` are module-private (not
 * exported), so the anime title-matching fallback is not unit-tested here.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VIDEO_EXTENSIONS, walkVideoFiles } from "./disk-scanner";

const MB = 1024 * 1024;
let root: string;

/** Create a sparse file of the given size (fast — no real blocks written). */
function sparseFile(rel: string, bytes: number): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
  fs.truncateSync(abs, bytes);
  return abs;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-scan-"));
});

/** Trees of their own, so the whole-root walk below doesn't see them. */
const scratch: string[] = [];

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("VIDEO_EXTENSIONS", () => {
  test("covers the common containers and nothing textual", () => {
    for (const ext of [".mkv", ".mp4", ".avi", ".m4v", ".ts", ".wmv"]) {
      expect(VIDEO_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(VIDEO_EXTENSIONS.has(".txt")).toBe(false);
    expect(VIDEO_EXTENSIONS.has(".srt")).toBe(false);
    expect(VIDEO_EXTENSIONS.has(".nfo")).toBe(false);
  });
});

describe("walkVideoFiles", () => {
  test("keeps small episodes and every common container, skips extras by name", async () => {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-kinds-"));
    scratch.push(sub);
    const at = (rel: string, mb: number) => {
      const abs = path.join(sub, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "");
      fs.truncateSync(abs, mb * MB);
      return abs;
    };
    const keep = [
      at("Anime/Season 01/Anime - S01E01 [x265].mkv", 40), // small HEVC episode
      at("Film (2020)/Film (2020).webm", 900),
      at("Old (1999)/Old (1999).mov", 700),
      at("Disc (2010)/Disc (2010).m2ts", 900),
      at("Trailer Park Boys/Season 01/Trailer Park Boys - S01E01.mkv", 300), // a show, not a trailer
    ];
    at("Film (2020)/Film (2020)-trailer.mkv", 80);
    at("Film (2020)/extras/Making Of.mkv", 300);
    at("Film (2020)/Behind The Scenes/Crew.mkv", 300);
    at("Film (2020)/Film (2020)-featurette2.mp4", 120);
    at("Film (2020)/.hidden/Film.mkv", 900);

    const found = (await walkVideoFiles(sub)).map((f) => f.absPath).sort();
    expect(found).toEqual(keep.sort());
  });

  test("follows a symlinked folder once, and never loops", async () => {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-links-"));
    scratch.push(sub);
    const real = path.join(sub, "real", "Show");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "Show - S01E01.mkv"), "");
    fs.truncateSync(path.join(real, "Show - S01E01.mkv"), 200 * MB);
    fs.mkdirSync(path.join(sub, "lib"));
    fs.symlinkSync(real, path.join(sub, "lib", "Show"));
    fs.symlinkSync(sub, path.join(real, "loop")); // points back up the tree

    const found = await walkVideoFiles(path.join(sub, "lib"));
    expect(found.map((f) => path.basename(f.absPath))).toEqual(["Show - S01E01.mkv"]);
  });

  test("recurses, keeps big videos, and skips small files / non-videos / samples", async () => {
    const keepFlat = sparseFile("Movie (2024)/movie.mkv", 60 * MB);
    const keepNested = sparseFile("Show/Season 01/Show.S01E01.1080p.mp4", 55 * MB);
    const keepUpper = sparseFile("Show/Season 01/Show.S01E02.1080p.MKV", 51 * MB); // extension case-insensitive
    sparseFile("Movie (2024)/movie-sample.txt", 60 * MB); // wrong extension
    sparseFile("Movie (2024)/tiny.mkv", 5 * MB); // under the 10 MB floor
    sparseFile("Movie (2024)/Movie.2024.sample.mkv", 60 * MB); // "sample" in the name
    sparseFile("Show/Season 01/subs.srt", 60 * MB); // wrong extension

    const found = await walkVideoFiles(root);
    const paths = found.map((f) => f.absPath).sort();
    expect(paths).toEqual([keepFlat, keepNested, keepUpper].sort());
    // Sizes are reported from stat.
    const bySize = new Map(found.map((f) => [f.absPath, f.size]));
    expect(bySize.get(keepFlat)).toBe(60 * MB);
    expect(bySize.get(keepNested)).toBe(55 * MB);
  });

  test("a file exactly at the 50 MB floor is kept", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-scan-floor-"));
    try {
      const p = path.join(dir, "edge.mkv");
      fs.writeFileSync(p, "");
      fs.truncateSync(p, 50 * MB);
      const found = await walkVideoFiles(dir);
      expect(found.map((f) => f.absPath)).toEqual([p]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or unreadable root resolves to an empty list (no throw)", async () => {
    expect(await walkVideoFiles(path.join(root, "does-not-exist"))).toEqual([]);
  });

  test("an empty directory yields an empty list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-scan-empty-"));
    try {
      expect(await walkVideoFiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
