/**
 * The backlog search's blind spot: "wanted" means `episodeFileId`/`movieFileId`
 * is null, and a renumber nulls that pointer without moving the file. So the job
 * kept re-grabbing episodes whose file was in the folder all along, which is how a
 * second copy of an anime episode gets into the library. It now asks the disk
 * before deciding something is missing — once per series, not once per episode.
 *
 * The folder walk and the indexer/grab layer are both mocked: what is under test
 * is which targets survive the filters.
 */
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-wanted-"));
process.env.CONFIG_DIR = TMP;
const SERIES_PATH = path.join(TMP, "tv", "Bleach");
const MOVIE_PATH = path.join(TMP, "movies", "Arrival (2016)");

const { library, grabbed, searched } = vi.hoisted(() => ({
  library: new Map<string, { absPath: string; size: number }[]>(),
  grabbed: [] as { mediaType: string; movieId?: number; episodeIds?: number[] }[],
  searched: [] as { episodeNumbers?: number[]; mediaType: string }[],
}));

vi.mock("@/server/library/disk-scanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/library/disk-scanner")>()),
  walkVideoFiles: async (root: string) => library.get(root) ?? [],
}));
vi.mock("@/server/indexers/release-search", () => ({
  searchReleases: async (target: { mediaType: string; episodeNumbers?: number[] }) => {
    searched.push({ mediaType: target.mediaType, episodeNumbers: target.episodeNumbers });
    return [{ accepted: true, title: "some release", guid: "g1" }];
  },
}));
vi.mock("@/server/download/download-service", () => ({
  grab: async (
    _release: unknown,
    target: { mediaType: string; movieId?: number; episodeIds?: number[] }
  ) => {
    grabbed.push(target);
    return { externalId: "x" };
  },
  episodesWithDownloadInFlight: () => new Set<number>(),
  moviesWithDownloadInFlight: () => new Set<number>(),
}));

const MB = 1024 * 1024;
function onDisk(root: string, ...names: string[]) {
  library.set(
    root,
    names.map((n) => ({ absPath: path.join(root, n), size: 900 * MB }))
  );
}

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let wantedSearchHandler: typeof import("./wanted-search").wantedSearchHandler;
let eq: typeof import("drizzle-orm").eq;
let seriesId: number;
let movieId: number;

const episodeAt = (episode: number) =>
  getDb()
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all()
    .find((e) => e.episodeNumber === episode)!;

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  ({ eq } = await import("drizzle-orm"));
  ({ wantedSearchHandler } = await import("./wanted-search"));
  const { QUALITIES, defaultProfileItems } = await import("@/server/parser/quality");

  const db = getDb();
  const profile = db
    .insert(schema.qualityProfiles)
    .values({
      name: "Any",
      cutoffQualityId: 19,
      items: defaultProfileItems(QUALITIES.filter((q) => q.id !== 0).map((q) => q.id)),
    })
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
      qualityProfileId: profile.id,
      isAnime: true,
      monitored: true,
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
      qualityProfileId: profile.id,
      monitored: true,
      status: "released",
      addedAt: new Date(),
    })
    .returning()
    .get().id;

  // Ten aired episodes; all but two are unmonitored, so the season-pack branch
  // never fires and each survivor is searched on its own.
  db.insert(schema.seasons).values({ seriesId, seasonNumber: 1 }).run();
  for (let n = 1; n <= 10; n++) {
    db.insert(schema.episodes)
      .values({
        seriesId,
        seasonNumber: 1,
        episodeNumber: n,
        absoluteNumber: n,
        title: `Episode ${n}`,
        monitored: n === 3 || n === 7,
        airDateUtc: new Date("2005-01-01"),
      })
      .run();
  }
}, 60_000);

beforeEach(() => {
  library.clear();
  grabbed.length = 0;
  searched.length = 0;
});

test("an episode whose file is on disk is not searched again; a genuinely missing one still is", async () => {
  onDisk(SERIES_PATH, "Bleach - S01E03 - 1080p WEB-DL.mkv");

  await wantedSearchHandler({ seriesId });

  expect(searched).toEqual([{ mediaType: "series", episodeNumbers: [7] }]);
  expect(grabbed).toEqual([{ mediaType: "series", seriesId, episodeIds: [episodeAt(7).id] }]);
}, 20_000);

test("a movie whose file is on disk is skipped entirely", async () => {
  onDisk(MOVIE_PATH, "Arrival.2016.1080p.BluRay.mkv");

  await wantedSearchHandler({ movieId });

  expect(searched).toEqual([]);
  expect(grabbed).toEqual([]);
});

test("nothing on disk leaves the backlog search exactly as it was", async () => {
  await wantedSearchHandler({ movieId });

  expect(grabbed).toEqual([{ mediaType: "movie", movieId }]);
}, 20_000);
