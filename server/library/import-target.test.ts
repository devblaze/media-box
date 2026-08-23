/**
 * What an import does when the release's own numbering disagrees with the
 * episode it was grabbed for.
 *
 * Anime releases routinely renumber themselves — "[Feibanyama] BLEACH Thousand
 * Year Blood War S01E43" is Bleach's 409th episode, filed under season 1 of a
 * show that doesn't exist as far as any metadata source is concerned. Parsing
 * that name points at the wrong episode, so a manual grab used to die with
 * "No importable video files matched the target episodes". A single-file grab
 * now trusts what it was grabbed for.
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-import-"));
process.env.CONFIG_DIR = TMP;
const LIBRARY = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-lib-"));
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-dl-"));

vi.mock("@/server/metadata/tmdb", () => ({}));
// The importer probes every imported file with ffprobe; there is none here.
vi.mock("@/server/library/media-info", () => ({ probeMediaInfo: async () => null }));
// Nothing to clean up in a real download client.
vi.mock("@/server/download/client", () => ({
  getClient: async () => ({ remove: async () => {} }),
}));

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let importDownload: typeof import("@/server/library/importer").importDownload;
let eq: typeof import("drizzle-orm").eq;
let seriesId: number;
let clientId: number;

/** Bleach as media-box sees it on TMDB's aired order: one long season + a sequel. */
const SEASONS: [number, number][] = [
  [1, 60],
  [2, 45],
];

function makeDownload(title: string, dir: string, episodeIds: number[]) {
  const abs = path.join(DOWNLOADS, dir);
  fs.mkdirSync(abs, { recursive: true });
  const videoPath = path.join(abs, `${title}.mkv`);
  fs.writeFileSync(videoPath, "");
  fs.truncateSync(videoPath, 60 * 1024 * 1024); // sparse; over the 20 MB floor
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
  ({ importDownload } = await import("@/server/library/importer"));
  ({ eq } = await import("drizzle-orm"));

  const db = getDb();
  db.insert(schema.namingConfig).values({ id: 1 }).run();
  const profile = db
    .insert(schema.qualityProfiles)
    .values({
      name: "Anime",
      cutoffQualityId: 3,
      items: Array.from({ length: 40 }, (_, i) => ({ qualityId: i, allowed: true })),
    })
    .returning()
    .get();
  clientId = db
    .insert(schema.downloadClients)
    .values({
      name: "TorBox",
      type: "torbox",
      settings: {},
      removeCompletedDownloads: false,
    })
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

  let absolute = 0;
  for (const [season, count] of SEASONS) {
    db.insert(schema.seasons).values({ seriesId, seasonNumber: season }).run();
    for (let n = 1; n <= count; n++) {
      absolute++;
      db.insert(schema.episodes)
        .values({
          seriesId,
          seasonNumber: season,
          episodeNumber: n,
          absoluteNumber: absolute,
          title: `Episode ${absolute}`,
          monitored: true,
        })
        .run();
    }
  }
}, 60_000);

beforeEach(() => {
  // Each test imports onto a fresh library so file names can't collide.
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

test("a single-file grab imports as the episode it was grabbed for, not what the name says", async () => {
  const target = episodeAt(2, 43); // absolute 103 — what the user clicked Search on
  const dl = makeDownload(
    "[Feibanyama] BLEACH Thousand Year Blood War S01E43 [IQIYI WebRip 2160p]",
    "tybw-43",
    [target.id]
  );

  await importDownload(dl.id);

  const after = episodeAt(2, 43);
  expect(after.episodeFileId).not.toBeNull();
  // The episode the NAME points at (S01E43) must not have been touched.
  expect(episodeAt(1, 43).episodeFileId).toBeNull();
  const file = getDb()
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.id, after.episodeFileId!))
    .get()!;
  expect(file.relativePath).toContain("S02E43");
});

test("a release that does match its target imports normally", async () => {
  const target = episodeAt(1, 12);
  const dl = makeDownload("Bleach S01E12 1080p WEB-DL", "bleach-s01e12", [target.id]);

  await importDownload(dl.id);
  expect(episodeAt(1, 12).episodeFileId).not.toBeNull();
});

test("an absolute-numbered fansub release maps through the absolute number", async () => {
  const target = episodeAt(2, 5); // absolute 65
  const dl = makeDownload("[SubsPlease] Bleach - 65 (1080p) [ABCD1234]", "bleach-65", [target.id]);

  await importDownload(dl.id);
  expect(episodeAt(2, 5).episodeFileId).not.toBeNull();
});

test("a multi-file download is still matched per file, and says why nothing imported", async () => {
  const target = episodeAt(1, 30);
  const dl = makeDownload("Some Pack", "pack", [target.id]);
  // A second file makes the grab non-authoritative: a pack must map by name.
  const extra = path.join(DOWNLOADS, "pack", "Bleach S09E99 1080p.mkv");
  fs.writeFileSync(extra, "");
  fs.truncateSync(extra, 60 * 1024 * 1024);

  await expect(importDownload(dl.id)).rejects.toThrow(/Nothing imported/);
  expect(episodeAt(1, 30).episodeFileId).toBeNull();

  const row = getDb().select().from(schema.downloads).where(eq(schema.downloads.id, dl.id)).get()!;
  expect(row.status).toBe("warning");
  // The message has to name the file and the problem — "nothing matched" alone
  // leaves the user with nothing to act on.
  expect(row.statusMessage).toMatch(/Nothing imported: /);
});
