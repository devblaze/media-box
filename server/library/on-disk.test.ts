/**
 * The disk, asked directly: `on-disk.ts` has to reach the same episode a file
 * WOULD have been imported as, including the two anime numberings, and the grab
 * guard has to refuse a release that only re-fetches a file already sitting there.
 *
 * The folder walk is mocked — what matters here is the filename→episode reasoning
 * and the upgrade decision made from it, not `walkVideoFiles` (covered in
 * disk-scanner.test.ts against a real temp tree).
 */
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-ondisk-"));
process.env.CONFIG_DIR = TMP;
const SERIES_PATH = path.join(TMP, "tv", "Bleach");
const MOVIE_PATH = path.join(TMP, "movies", "Arrival (2016)");

/** Folder → the video files the walk reports for it. */
const { walked } = vi.hoisted(() => ({
  walked: new Map<string, { absPath: string; size: number }[]>(),
}));
vi.mock("@/server/library/disk-scanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/library/disk-scanner")>()),
  walkVideoFiles: async (root: string) => walked.get(root) ?? [],
}));

const MB = 1024 * 1024;
/** Register a file with the mocked walk (nothing is written to disk). */
function onDisk(root: string, ...names: string[]) {
  walked.set(
    root,
    names.map((n) => ({ absPath: path.join(root, n), size: 900 * MB }))
  );
}

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let onDiskMod: typeof import("./on-disk");
let eq: typeof import("drizzle-orm").eq;
let profile: import("@/server/parser/scoring").ProfileLike;
let seriesId: number;
let movieId: number;

/** Bleach on TMDB's aired order: one long season plus a sequel season. */
const SEASONS: [number, number][] = [
  [1, 60],
  [2, 45],
];

const episodeAt = (season: number, episode: number) =>
  getDb()
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all()
    .find((e) => e.seasonNumber === season && e.episodeNumber === episode)!;

const quality = (id: number) => ({ qualityId: id, revision: { version: 1, real: 0 } });

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  ({ eq } = await import("drizzle-orm"));
  onDiskMod = await import("./on-disk");
  const { QUALITIES, defaultProfileItems } = await import("@/server/parser/quality");
  profile = {
    cutoffQualityId: 7, // Bluray-1080p
    upgradeAllowed: true,
    items: defaultProfileItems(QUALITIES.filter((q) => q.id !== 0).map((q) => q.id)),
  };

  const db = getDb();
  const profileRow = db
    .insert(schema.qualityProfiles)
    .values({ name: "Any", cutoffQualityId: 7, items: profile.items })
    .returning()
    .get();
  seriesId = db
    .insert(schema.series)
    .values({
      tmdbId: 30984,
      title: "Bleach",
      sortTitle: "bleach",
      year: 2004,
      path: SERIES_PATH,
      qualityProfileId: profileRow.id,
      isAnime: true,
      addedAt: new Date(),
    })
    .returning()
    .get().id;
  movieId = db
    .insert(schema.movies)
    .values({
      tmdbId: 329865,
      title: "Arrival",
      sortTitle: "arrival",
      year: 2016,
      path: MOVIE_PATH,
      qualityProfileId: profileRow.id,
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
  walked.clear();
  const db = getDb();
  db.update(schema.episodes)
    .set({ episodeFileId: null })
    .where(eq(schema.episodes.seriesId, seriesId))
    .run();
  db.delete(schema.episodeFiles).where(eq(schema.episodeFiles.seriesId, seriesId)).run();
  db.update(schema.movies).set({ movieFileId: null }).where(eq(schema.movies.id, movieId)).run();
  db.delete(schema.movieFiles).where(eq(schema.movieFiles.movieId, movieId)).run();
});

describe("episodeFilesOnDisk", () => {
  test("maps an SxxExx file to its episode, with the quality its name carries", async () => {
    onDisk(SERIES_PATH, "Season 01/Bleach - S01E12 - 1080p WEB-DL.mkv");

    const found = await onDiskMod.episodeFilesOnDisk(seriesId);
    const hit = found.get(episodeAt(1, 12).id);
    expect(hit?.absPath).toContain("S01E12");
    expect(hit?.quality.qualityId).toBe(3); // WEB-DL-1080p
    expect(found.size).toBe(1);
  });

  test("an absolute-numbered fansub file lands on the episode that absolute number is", async () => {
    // Absolute 65 is S02E05 — nothing in the name says so.
    onDisk(SERIES_PATH, "[SubsPlease] Bleach - 65 (1080p) [ABCD1234].mkv");

    const found = await onDiskMod.episodeFilesOnDisk(seriesId);
    expect(found.has(episodeAt(2, 5).id)).toBe(true);
    expect(found.has(episodeAt(1, 5).id)).toBe(false);
  });

  test("an SxxExx number past the end of that season is read as an absolute one", async () => {
    // Season 1 stops at 60, so "S01E100" can only mean absolute 100 = S02E40.
    onDisk(SERIES_PATH, "Bleach - S01E100 - 720p HDTV.mkv");

    const found = await onDiskMod.episodeFilesOnDisk(seriesId);
    expect(found.has(episodeAt(2, 40).id)).toBe(true);
  });

  test("two files claiming one episode report the better of them", async () => {
    onDisk(
      SERIES_PATH,
      "Season 01/Bleach - S01E20 - 720p HDTV.mkv",
      "Bleach - S01E20 - 1080p WEB-DL.mkv"
    );

    const found = await onDiskMod.episodeFilesOnDisk(seriesId);
    expect(found.get(episodeAt(1, 20).id)?.quality.qualityId).toBe(3); // not the 720p
  });

  test("a name that identifies no episode of this series is ignored", async () => {
    onDisk(SERIES_PATH, "Bleach - S09E99 - 1080p WEB-DL.mkv", "some-extra-featurette.mkv");

    expect((await onDiskMod.episodeFilesOnDisk(seriesId)).size).toBe(0);
  });
});

describe("movieFileOnDisk", () => {
  test("reports the best file in the folder", async () => {
    onDisk(MOVIE_PATH, "Arrival.2016.720p.HDTV.mkv", "Arrival.2016.1080p.BluRay.mkv");

    const found = await onDiskMod.movieFileOnDisk(movieId);
    expect(found?.absPath).toContain("1080p");
    expect(found?.quality.qualityId).toBe(7); // Bluray-1080p
    expect(await onDiskMod.movieFilesOnDisk(movieId)).toHaveLength(2);
  });

  test("an empty folder is null, not a throw", async () => {
    expect(await onDiskMod.movieFileOnDisk(movieId)).toBeNull();
  });
});

describe("existingFileBlockingGrab", () => {
  const seriesTarget = (episodeIds: number[]) =>
    ({ mediaType: "series", seriesId, episodeIds }) as const;

  test("refuses an episode grab that only re-fetches the file already on disk", async () => {
    onDisk(SERIES_PATH, "Bleach - S01E12 - 1080p WEB-DL.mkv");
    const episodeId = episodeAt(1, 12).id;

    const blocked = await onDiskMod.existingFileBlockingGrab(
      seriesTarget([episodeId]),
      profile,
      quality(4) // HDTV-720p — worse than what's there
    );
    expect(blocked).toContain("S01E12");
    expect(blocked).toContain("Override");
  });

  test("lets a genuine upgrade over the stray file through", async () => {
    onDisk(SERIES_PATH, "Bleach - S01E12 - 1080p WEB-DL.mkv");

    expect(
      await onDiskMod.existingFileBlockingGrab(
        seriesTarget([episodeAt(1, 12).id]),
        profile,
        quality(7) // Bluray-1080p
      )
    ).toBeNull();
  });

  test("an episode the database already links is left to the normal upgrade rules", async () => {
    onDisk(SERIES_PATH, "Bleach - S01E12 - 1080p WEB-DL.mkv");
    const db = getDb();
    const fileId = db
      .insert(schema.episodeFiles)
      .values({
        seriesId,
        relativePath: "Bleach - S01E12 - 1080p WEB-DL.mkv",
        size: 900 * MB,
        quality: quality(3),
        dateAdded: new Date(),
      })
      .returning()
      .get().id;
    const episodeId = episodeAt(1, 12).id;
    db.update(schema.episodes)
      .set({ episodeFileId: fileId })
      .where(eq(schema.episodes.id, episodeId))
      .run();

    expect(
      await onDiskMod.existingFileBlockingGrab(seriesTarget([episodeId]), profile, quality(4))
    ).toBeNull();
  });

  test("a season pack that still fills a genuinely missing episode is allowed", async () => {
    onDisk(SERIES_PATH, "Bleach - S01E12 - 1080p WEB-DL.mkv");

    expect(
      await onDiskMod.existingFileBlockingGrab(
        seriesTarget([episodeAt(1, 12).id, episodeAt(1, 13).id]),
        profile,
        quality(4)
      )
    ).toBeNull();
  });

  test("refuses a movie grab when the file is already in the folder", async () => {
    onDisk(MOVIE_PATH, "Arrival.2016.1080p.BluRay.mkv");

    const blocked = await onDiskMod.existingFileBlockingGrab(
      { mediaType: "movie", movieId },
      profile,
      quality(9) // HDTV-1080p
    );
    expect(blocked).toContain("Arrival");
    expect(
      await onDiskMod.existingFileBlockingGrab({ mediaType: "movie", movieId }, profile, quality(19))
    ).toBeNull(); // Bluray-2160p is an upgrade
  });

  test("nothing on disk blocks nothing", async () => {
    expect(
      await onDiskMod.existingFileBlockingGrab(
        seriesTarget([episodeAt(1, 12).id]),
        profile,
        quality(4)
      )
    ).toBeNull();
    expect(
      await onDiskMod.existingFileBlockingGrab({ mediaType: "movie", movieId }, profile, quality(4))
    ).toBeNull();
  });
});
