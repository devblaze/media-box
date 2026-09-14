/**
 * What an import does when the episode's file pointer is null but the file is
 * still sitting in the library.
 *
 * That is the state a renumber leaves behind — `setEpisodeOrdering` nulls every
 * link, RefreshSeries deletes the file record — and because every "do we have
 * this?" check read the pointer alone, the episode was grabbed again and the new
 * copy landed beside the old one under a different name. The importer now asks the
 * disk: a repeat is refused, a genuine upgrade replaces the stray file instead of
 * joining it.
 *
 * The folder walk is mocked (the importer's own download-side scan is not); the
 * library files are real so the deletions can be asserted.
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-orphan-"));
process.env.CONFIG_DIR = TMP;
const LIBRARY = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-orphan-lib-"));
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-orphan-dl-"));

const MB = 1024 * 1024;

/** What the (mocked) library walk reports — the tests put real files in here. */
const { library } = vi.hoisted(() => ({
  library: [] as { absPath: string; size: number }[],
}));

vi.mock("@/server/metadata/tmdb", () => ({}));
vi.mock("@/server/library/media-info", () => ({ probeMediaInfo: async () => null }));
vi.mock("@/server/download/client", () => ({
  getClient: async () => ({ remove: async () => {} }),
}));
vi.mock("@/server/library/disk-scanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/library/disk-scanner")>()),
  walkVideoFiles: async () => library,
}));

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let importDownload: typeof import("./importer").importDownload;
let eq: typeof import("drizzle-orm").eq;
let seriesId: number;
let clientId: number;

/** A real (sparse) file in the library that the walk will report. */
function orphanFile(name: string): string {
  const abs = path.join(LIBRARY, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
  fs.truncateSync(abs, 900 * MB);
  library.push({ absPath: abs, size: 900 * MB });
  return abs;
}

function makeDownload(title: string, dir: string, episodeIds: number[]) {
  const abs = path.join(DOWNLOADS, dir);
  fs.mkdirSync(abs, { recursive: true });
  const videoPath = path.join(abs, `${title}.mkv`);
  fs.writeFileSync(videoPath, "");
  fs.truncateSync(videoPath, 60 * MB);
  return getDb()
    .insert(schema.downloads)
    .values({
      downloadClientId: clientId,
      externalId: dir,
      title,
      mediaType: "series",
      seriesId,
      episodeIds,
      quality: { qualityId: 3, revision: { version: 1, real: 0 } },
      status: "importPending",
      outputPath: abs,
      grabbedAt: new Date(),
    })
    .returning()
    .get();
}

const episodeAt = (season: number, episode: number) =>
  getDb()
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all()
    .find((e) => e.seasonNumber === season && e.episodeNumber === episode)!;

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  ({ importDownload } = await import("./importer"));
  ({ eq } = await import("drizzle-orm"));
  const { QUALITIES, defaultProfileItems } = await import("@/server/parser/quality");

  const db = getDb();
  db.insert(schema.namingConfig).values({ id: 1 }).run();
  const profile = db
    .insert(schema.qualityProfiles)
    .values({
      name: "Any",
      cutoffQualityId: 19,
      items: defaultProfileItems(QUALITIES.filter((q) => q.id !== 0).map((q) => q.id)),
    })
    .returning()
    .get();
  clientId = db
    .insert(schema.downloadClients)
    .values({ name: "TorBox", type: "torbox", settings: {}, removeCompletedDownloads: false })
    .returning()
    .get().id;
  seriesId = db
    .insert(schema.series)
    .values({
      tmdbId: 30984,
      title: "Bleach",
      sortTitle: "bleach",
      year: 2004,
      path: LIBRARY,
      qualityProfileId: profile.id,
      isAnime: true,
      addedAt: new Date(),
    })
    .returning()
    .get().id;

  db.insert(schema.seasons).values({ seriesId, seasonNumber: 1 }).run();
  for (let n = 1; n <= 30; n++) {
    db.insert(schema.episodes)
      .values({
        seriesId,
        seasonNumber: 1,
        episodeNumber: n,
        absoluteNumber: n,
        title: `Episode ${n}`,
        monitored: true,
      })
      .run();
  }
}, 60_000);

beforeEach(() => {
  library.length = 0;
  fs.rmSync(LIBRARY, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY, { recursive: true });
  const db = getDb();
  db.update(schema.episodes)
    .set({ episodeFileId: null })
    .where(eq(schema.episodes.seriesId, seriesId))
    .run();
  db.delete(schema.episodeFiles).where(eq(schema.episodeFiles.seriesId, seriesId)).run();
});

afterAll(() => {
  for (const dir of [TMP, LIBRARY, DOWNLOADS]) fs.rmSync(dir, { recursive: true, force: true });
});

test("a re-grab of an episode whose file is still on disk is refused, and nothing is deleted", async () => {
  const stray = orphanFile("Bleach - S01E12 - 1080p WEB-DL.mkv");
  const dl = makeDownload("Bleach S01E12 720p HDTV", "s01e12-720p", [episodeAt(1, 12).id]);

  await expect(importDownload(dl.id)).rejects.toThrow(/already on disk for S01E12/);

  expect(fs.existsSync(stray)).toBe(true);
  expect(episodeAt(1, 12).episodeFileId).toBeNull();
  const row = getDb().select().from(schema.downloads).where(eq(schema.downloads.id, dl.id)).get()!;
  expect(row.status).toBe("warning");
  expect(row.statusMessage).toMatch(/isn't an upgrade over it/);
});

test("a real upgrade imports and takes the stray copy with it", async () => {
  const stray = orphanFile("Bleach - S01E20 - 720p HDTV.mkv");
  const dl = makeDownload("Bleach S01E20 1080p WEB-DL", "s01e20-1080p", [episodeAt(1, 20).id]);

  await importDownload(dl.id);

  // The episode is linked to the new file...
  const fileId = episodeAt(1, 20).episodeFileId;
  expect(fileId).not.toBeNull();
  const file = getDb()
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.id, fileId!))
    .get()!;
  expect(file.relativePath).toContain("S01E20");
  // ...and the copy nothing pointed at is gone, rather than sitting beside it.
  expect(fs.existsSync(stray)).toBe(false);
  expect(fs.existsSync(path.join(LIBRARY, file.relativePath))).toBe(true);
});

test("a stray file for a DIFFERENT episode changes nothing", async () => {
  const other = orphanFile("Bleach - S01E01 - 1080p WEB-DL.mkv");
  const dl = makeDownload("Bleach S01E25 720p HDTV", "s01e25-720p", [episodeAt(1, 25).id]);

  await importDownload(dl.id);

  expect(episodeAt(1, 25).episodeFileId).not.toBeNull();
  expect(fs.existsSync(other)).toBe(true);
});

test("a two-episode file another episode still links is never deleted", async () => {
  // S01E05-E06 in one file: E05 keeps its link, E06's was dropped. Upgrading E06
  // must not take E05's only copy with it.
  const shared = orphanFile("Bleach - S01E05E06 - 720p HDTV.mkv");
  const db = getDb();
  const sharedId = db
    .insert(schema.episodeFiles)
    .values({
      seriesId,
      relativePath: path.relative(LIBRARY, shared),
      size: 900 * MB,
      quality: { qualityId: 4, revision: { version: 1, real: 0 } },
      dateAdded: new Date(),
    })
    .returning()
    .get().id;
  db.update(schema.episodes)
    .set({ episodeFileId: sharedId })
    .where(eq(schema.episodes.id, episodeAt(1, 5).id))
    .run();
  const dl = makeDownload("Bleach S01E06 1080p WEB-DL", "s01e06-1080p", [episodeAt(1, 6).id]);

  await importDownload(dl.id);

  expect(episodeAt(1, 6).episodeFileId).not.toBe(sharedId);
  expect(fs.existsSync(shared)).toBe(true);
  expect(episodeAt(1, 5).episodeFileId).toBe(sharedId);
});

test("an override grabs past the guard and still replaces the stray copy", async () => {
  const stray = orphanFile("Bleach - S01E14 - 1080p WEB-DL.mkv");
  const dl = makeDownload("Bleach S01E14 720p HDTV", "s01e14-override", [episodeAt(1, 14).id]);
  getDb()
    .update(schema.downloads)
    .set({ override: true })
    .where(eq(schema.downloads.id, dl.id))
    .run();

  await importDownload(dl.id);

  expect(episodeAt(1, 14).episodeFileId).not.toBeNull();
  expect(fs.existsSync(stray)).toBe(false);
});
