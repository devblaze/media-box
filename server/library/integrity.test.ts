/**
 * The database's idea of the library versus the disk's.
 *
 * These two drift apart in both directions and each direction breaks something
 * different: a pointer with no file behind it makes playback 404 while the title
 * still claims to be available, and a file with no pointer makes an episode read
 * as missing so it gets downloaded a second time. Anime hit the second case
 * routinely, because they are the only series whose episodes get renumbered.
 */
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-integrity-"));
process.env.CONFIG_DIR = TMP;
const LIBRARY = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-integrity-lib-"));
const MOVIES = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-integrity-movies-"));

vi.mock("@/server/metadata/tmdb", () => ({}));

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let checkLibraryIntegrity: typeof import("./integrity").checkLibraryIntegrity;
let seriesId: number;

/** The disk walker ignores anything under 50 MB, so test files must clear it. */
function writeVideo(absPath: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, "");
  fs.truncateSync(absPath, 60 * 1024 * 1024); // sparse
}

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  ({ checkLibraryIntegrity } = await import("./integrity"));

  const db = getDb();
  const profile = db
    .insert(schema.qualityProfiles)
    .values({ name: "Any", cutoffQualityId: 3, items: [{ qualityId: 3, allowed: true }] })
    .returning()
    .get();
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
});

/** One episode, its file row, and optionally the file itself. */
function makeEpisode(episodeNumber: number, relativePath: string, onDisk: boolean): number {
  const db = getDb();
  const file = db
    .insert(schema.episodeFiles)
    .values({ seriesId, relativePath, size: 1, quality: { qualityId: 3, revision: { version: 1, real: 0 } }, dateAdded: new Date() })
    .returning()
    .get();
  const episode = db
    .insert(schema.episodes)
    .values({ seriesId, seasonNumber: 1, episodeNumber, monitored: true, episodeFileId: file.id })
    .returning()
    .get();
  if (onDisk) writeVideo(path.join(LIBRARY, relativePath));
  return episode.id;
}

beforeEach(() => {
  const db = getDb();
  db.delete(schema.episodes).run();
  db.delete(schema.episodeFiles).run();
  db.delete(schema.movies).run();
  db.delete(schema.movieFiles).run();
  fs.rmSync(LIBRARY, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY, { recursive: true });
});

describe("pointers with no file behind them", () => {
  test("a linked episode whose file is present is counted, not reported", async () => {
    makeEpisode(1, "Season 01/Bleach - S01E01.mkv", true);
    const report = await checkLibraryIntegrity();
    expect(report.episodes.linked).toBe(1);
    expect(report.episodes.missing).toEqual([]);
  });

  test("a linked episode whose file is gone is reported with the path the database believes", async () => {
    // This is what makes playback 404: resolveMediaPath composes exactly this
    // path from the same two columns and hands it to the stream route.
    makeEpisode(46, "Season 01/Bleach - S01E46.mkv", false);
    const report = await checkLibraryIntegrity();
    expect(report.episodes.linked).toBe(1);
    expect(report.episodes.missing).toHaveLength(1);
    expect(report.episodes.missing[0]).toMatchObject({
      kind: "episode",
      title: "Bleach S01E46",
      absPath: path.join(LIBRARY, "Season 01/Bleach - S01E46.mkv"),
    });
  });

  test("an episode with no file pointer at all is neither linked nor missing", async () => {
    // It is simply not downloaded. The interesting case is the orphan sweep below.
    getDb()
      .insert(schema.episodes)
      .values({ seriesId, seasonNumber: 1, episodeNumber: 2, monitored: true })
      .run();
    const report = await checkLibraryIntegrity();
    expect(report.episodes.linked).toBe(0);
    expect(report.episodes.missing).toEqual([]);
  });

  test("movies are checked the same way", async () => {
    const db = getDb();
    // The file row's movieId is a real foreign key, so the movie has to exist
    // before the file, and the pointer back is set afterwards.
    const movie = db
      .insert(schema.movies)
      .values({
        tmdbId: 438631,
        title: "Dune",
        sortTitle: "dune",
        year: 2021,
        path: MOVIES,
        qualityProfileId: 1,
        monitored: true,
        addedAt: new Date(),
      })
      .returning()
      .get();
    const file = db
      .insert(schema.movieFiles)
      .values({ movieId: movie.id, relativePath: "Dune (2021).mkv", size: 1, quality: { qualityId: 3, revision: { version: 1, real: 0 } }, dateAdded: new Date() })
      .returning()
      .get();
    db.update(schema.movies).set({ movieFileId: file.id }).run();

    const report = await checkLibraryIntegrity();
    expect(report.movies.linked).toBe(1);
    expect(report.movies.missing[0]).toMatchObject({ kind: "movie", title: "Dune (2021)" });
  });
});

describe("files with no pointer", () => {
  test("the sweep is opt-in, and says so when it was skipped", async () => {
    // It reads every library folder, so it must not be the default.
    const report = await checkLibraryIntegrity();
    expect(report.orphans).toEqual([]);
    expect(report.orphansPartial).toBe(true);
  });

  test("a file nothing points at is reported against the series it sits under", async () => {
    // The duplicate-episode bug in one assertion: this file is real, watchable,
    // and invisible to every "do we already have this?" check in the app.
    makeEpisode(1, "Season 01/Bleach - S01E01.mkv", true);
    writeVideo(path.join(LIBRARY, "Season 03/Bleach - S03E01 - The Rescue.mkv"));

    const report = await checkLibraryIntegrity({ includeOrphans: true });
    expect(report.orphansPartial).toBe(false);
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toMatchObject({ belongsTo: "Bleach" });
    expect(report.orphans[0].absPath).toContain("S03E01");
  });

  test("a file a row does point at is not an orphan", async () => {
    makeEpisode(1, "Season 01/Bleach - S01E01.mkv", true);
    const report = await checkLibraryIntegrity({ includeOrphans: true });
    expect(report.orphans).toEqual([]);
  });

  test("a file whose episode was dropped is reported as unlinked, not as an orphan", async () => {
    // This is the exact state syncSeasonsAndEpisodes leaves behind when an
    // ordering change stops covering an episode: the file and its record both
    // survive, but nothing points at them. Every "do we already have this?"
    // check reads the episode pointer, so the episode reads as missing and gets
    // downloaded again — which is where the second copy comes from.
    makeEpisode(1, "Season 01/Bleach - S01E01.mkv", true);
    getDb().delete(schema.episodes).run();

    const report = await checkLibraryIntegrity({ includeOrphans: true });
    // Not an orphan: a record still names it, so a rescan can re-link it.
    expect(report.orphans).toEqual([]);
    expect(report.unlinkedFiles).toHaveLength(1);
    expect(report.unlinkedFiles[0]).toMatchObject({ belongsTo: "Bleach" });
    expect(report.unlinkedFiles[0].absPath).toContain("S01E01");
  });

  test("a linked file is not reported as unlinked", async () => {
    makeEpisode(1, "Season 01/Bleach - S01E01.mkv", true);
    const report = await checkLibraryIntegrity();
    expect(report.unlinkedFiles).toEqual([]);
  });
});
