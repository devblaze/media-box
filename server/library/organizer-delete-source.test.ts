/**
 * The organizer's opt-in "delete what it came from" step.
 *
 * This is the one part of organizing that destroys data, so the rules that stop
 * it are asserted directly rather than inferred from the outcome of a whole
 * organize. The failure that matters is deleting a source when the destination
 * did not actually land — that loses the only copy.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let organizerDeleteSource = true;
let fileOperationsEnabled = true;

vi.mock("@/server/settings/settings-service", () => ({
  getSettings: () => ({ organizerDeleteSource }),
}));
// removeMedia carries the read-only master switch; this stands in for it.
vi.mock("./media-guard", () => ({
  fileOperationsMode: () => (fileOperationsEnabled ? "allow" : "off"),
  assertFileOperationsEnabled: () => {
    if (!fileOperationsEnabled) throw new Error("File operations are disabled");
  },
}));
vi.mock("@/server/logging/logger", () => ({ recordLog: () => {} }));

import { deleteRedundantSource, deleteSourceIfEnabled } from "./organizer-service";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-organize-"));

function write(name: string, bytes = 1024): string {
  const abs = path.join(TMP, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes, 1));
  return abs;
}

beforeEach(() => {
  organizerDeleteSource = true;
  fileOperationsEnabled = true;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

describe("deleteSourceIfEnabled", () => {
  test("deletes the source once the destination is really there", async () => {
    const src = write("downloads/movie.mkv");
    const dest = write("library/Movie (2024).mkv");
    await expect(deleteSourceIfEnabled(src, dest, "hardlink")).resolves.toBe(true);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  test("does nothing at all when the setting is off", async () => {
    organizerDeleteSource = false;
    const src = write("downloads/movie.mkv");
    const dest = write("library/Movie (2024).mkv");
    await expect(deleteSourceIfEnabled(src, dest, "copy")).resolves.toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  test("keeps the source when the destination is missing", async () => {
    // The placement failed or was rolled back. Deleting here would destroy the
    // only copy, so this is the assertion that matters most in this file.
    const src = write("downloads/movie.mkv");
    await expect(
      deleteSourceIfEnabled(src, path.join(TMP, "library/never-written.mkv"), "copy")
    ).resolves.toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  test("keeps the source when the destination landed empty", async () => {
    // A zero-byte destination is a truncated copy, not a successful one.
    const src = write("downloads/movie.mkv");
    const dest = write("library/Movie (2024).mkv", 0);
    await expect(deleteSourceIfEnabled(src, dest, "copy")).resolves.toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  test("a move has nothing left to delete", async () => {
    const dest = write("library/Movie (2024).mkv");
    const src = path.join(TMP, "downloads/already-gone.mkv");
    await expect(deleteSourceIfEnabled(src, dest, "move")).resolves.toBe(false);
  });

  test("never deletes when source and destination are the same file", async () => {
    // Organizing a file that is already in place would otherwise delete it.
    const abs = write("library/Movie (2024).mkv");
    const viaDots = path.join(path.dirname(abs), ".", path.basename(abs));
    await expect(deleteSourceIfEnabled(viaDots, abs, "copy")).resolves.toBe(false);
    expect(fs.existsSync(abs)).toBe(true);
  });

  test("read-only mode deletes nothing, and the organize still succeeds", async () => {
    fileOperationsEnabled = false;
    const src = write("downloads/movie.mkv");
    const dest = write("library/Movie (2024).mkv");
    await expect(deleteSourceIfEnabled(src, dest, "hardlink")).resolves.toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });
});

/**
 * Deleting a download because "we already have it" rests entirely on that being
 * true. The pointer saying so is not enough: an ordering change drops the link
 * while the file stays, and a stale pointer names a file deleted outside
 * media-box. In the second case the download is the only copy left, and
 * deleting it on the pointer's word destroys the title.
 */
describe("deleteRedundantSource", () => {
  test("deletes the download once the library copy is confirmed present", async () => {
    const src = write("downloads/bleach-046.mkv");
    const lib = write("library/Bleach - S01E46.mkv");
    const res = await deleteRedundantSource(src, [lib]);
    expect(res.deleted).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(lib)).toBe(true);
  });

  test("keeps the download when the library copy is not actually there", async () => {
    // The pointer is stale. This download is the only copy left.
    const src = write("downloads/bleach-046.mkv");
    const res = await deleteRedundantSource(src, [path.join(TMP, "library/gone.mkv")]);
    expect(res.deleted).toBe(false);
    expect(res.note).toContain("library copy is missing");
    expect(fs.existsSync(src)).toBe(true);
  });

  test("keeps the download when the library copy is an empty stub", async () => {
    const src = write("downloads/bleach-046.mkv");
    const res = await deleteRedundantSource(src, [write("library/Bleach - S01E46.mkv", 0)]);
    expect(res.deleted).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  test("a multi-episode file needs EVERY copy present, not just one", async () => {
    // A file covering 46 and 47 where only 46 is in the library is still the
    // only source of 47.
    const src = write("downloads/bleach-046-047.mkv");
    const present = write("library/Bleach - S01E46.mkv");
    const missing = path.join(TMP, "library/Bleach - S01E47.mkv");
    const res = await deleteRedundantSource(src, [present, missing]);
    expect(res.deleted).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  test("keeps the download when there is nothing recorded to compare against", async () => {
    const src = write("downloads/bleach-046.mkv");
    const res = await deleteRedundantSource(src, []);
    expect(res.deleted).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  test("never deletes when the library copy IS the file being organized", async () => {
    const abs = write("library/Bleach - S01E46.mkv");
    const res = await deleteRedundantSource(abs, [abs]);
    expect(res.deleted).toBe(false);
    expect(fs.existsSync(abs)).toBe(true);
  });

  test("read-only mode deletes nothing", async () => {
    fileOperationsEnabled = false;
    const src = write("downloads/bleach-046.mkv");
    const res = await deleteRedundantSource(src, [write("library/Bleach - S01E46.mkv")]);
    expect(res.deleted).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });

  test("the setting for deleting after organizing does not govern this", async () => {
    // Different action, different consent: skipAndDelete is chosen per run.
    organizerDeleteSource = false;
    const src = write("downloads/bleach-046.mkv");
    const res = await deleteRedundantSource(src, [write("library/Bleach - S01E46.mkv")]);
    expect(res.deleted).toBe(true);
  });
});
