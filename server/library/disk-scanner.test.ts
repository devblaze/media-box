/**
 * Covers the exported pure-ish pieces of the disk scanner: `VIDEO_EXTENSIONS`
 * and `walkVideoFiles` (against a throwaway temp tree; the ≥50 MB minimum-size
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

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
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
  test("recurses, keeps big videos, and skips small files / non-videos / samples", async () => {
    const keepFlat = sparseFile("Movie (2024)/movie.mkv", 60 * MB);
    const keepNested = sparseFile("Show/Season 01/Show.S01E01.1080p.mp4", 55 * MB);
    const keepUpper = sparseFile("Show/Season 01/Show.S01E02.1080p.MKV", 51 * MB); // extension case-insensitive
    sparseFile("Movie (2024)/movie-sample.txt", 60 * MB); // wrong extension
    sparseFile("Movie (2024)/tiny.mkv", 10 * MB); // under the 50 MB floor
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
