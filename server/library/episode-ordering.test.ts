/**
 * DB-backed test for re-numbering a series onto another TMDB ordering.
 *
 * The dangerous part is that episodes MOVE: TMDB's aired Bleach S01E042 has to
 * become S03E01 without tripping the (series, season, episode) unique index,
 * without duplicating rows, and without losing the row identity that watch
 * progress, subtitles and episode files hang off.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-ordering-"));
process.env.CONFIG_DIR = TMP;

const AIRED_SEASONS = [
  { season_number: 0, episode_count: 2 },
  { season_number: 1, episode_count: 63 },
  { season_number: 2, episode_count: 5 },
];

const tmdbEpisodeId = (season: number, episode: number) => season * 10_000 + episode;

const airedSeason = (season: number, count: number) => ({
  season_number: season,
  episodes: Array.from({ length: count }, (_, i) => ({
    id: tmdbEpisodeId(season, i + 1),
    season_number: season,
    episode_number: i + 1,
    name: `S${season} #${i + 1}`,
    overview: "",
    air_date: "2004-10-05",
    runtime: 24,
  })),
});

/** Arc seasons the way TMDB's "TVDB Order" group describes them. */
const arcs: [number, string, number, number, number][] = [
  // [group order, name, native season, from, to]
  [1, "Substitute Shinigami", 1, 1, 20],
  [2, "The Entry", 1, 21, 41],
  [3, "The Rescue", 1, 42, 63],
  [4, "Thousand-Year Blood War", 2, 1, 5],
  [0, "Specials", 0, 1, 2],
];

const TVDB_GROUP = {
  id: "tvdb",
  name: "TVDB Order",
  type: 1,
  groups: arcs.map(([order, name, season, from, to]) => ({
    id: `g${order}`,
    name,
    order,
    episodes: Array.from({ length: to - from + 1 }, (_, i) => ({
      id: tmdbEpisodeId(season, from + i),
      season_number: season,
      episode_number: from + i,
      order: i,
      name: `S${season} #${from + i}`,
      overview: "",
      air_date: "2004-10-05",
      runtime: 24,
    })),
  })),
};

vi.mock("@/server/metadata/tmdb", () => ({
  getTvSeason: async (_id: number, season: number) =>
    airedSeason(season, AIRED_SEASONS.find((s) => s.season_number === season)!.episode_count),
  getTvEpisodeGroup: async () => TVDB_GROUP,
  getTvEpisodeGroups: async () => ({ results: [] }),
}));

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let svc: typeof import("@/server/library/series-service");
let eq: typeof import("drizzle-orm").eq;
let seriesId: number;

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  svc = await import("@/server/library/series-service");
  ({ eq } = await import("drizzle-orm"));

  const db = getDb();
  const profile = db
    .insert(schema.qualityProfiles)
    .values({ name: "Anime", cutoffQualityId: 1, items: [{ qualityId: 1 }] })
    .returning()
    .get();
  seriesId = db
    .insert(schema.series)
    .values({
      tmdbId: 30984,
      title: "Bleach",
      sortTitle: "bleach",
      year: 2004,
      path: "/tv/Anime/Bleach",
      qualityProfileId: profile.id,
      isAnime: true,
      addedAt: new Date(),
    })
    .returning()
    .get().id;

  await svc.syncSeasonsAndEpisodes(seriesId, 30984, AIRED_SEASONS, null);
}, 60_000);

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const episodes = () =>
  getDb().select().from(schema.episodes).where(eq(schema.episodes.seriesId, seriesId)).all();

test("the aired order is TMDB's own, with absolute numbers spanning the seasons", () => {
  const eps = episodes();
  expect(eps).toHaveLength(70); // 2 specials + 63 + 5
  const seasons = new Set(eps.map((e) => e.seasonNumber));
  expect(seasons).toEqual(new Set([0, 1, 2]));
  expect(eps.find((e) => e.seasonNumber === 2 && e.episodeNumber === 3)!.absoluteNumber).toBe(66);
  expect(eps.find((e) => e.seasonNumber === 0 && e.episodeNumber === 1)!.absoluteNumber).toBeNull();
});

test("switching to the TVDB grouping renumbers in place", async () => {
  const db = getDb();
  const before = episodes();
  const idOfNative = (season: number, episode: number) =>
    before.find((e) => e.tmdbEpisodeId === tmdbEpisodeId(season, episode))!.id;
  const rescueOpenerId = idOfNative(1, 42);
  const tybwId = idOfNative(2, 3);

  // Something hanging off an episode row must survive the renumber.
  db.update(schema.episodes)
    .set({ monitored: false })
    .where(eq(schema.episodes.id, rescueOpenerId))
    .run();

  await svc.syncSeasonsAndEpisodes(seriesId, 30984, AIRED_SEASONS, "tvdb");

  const after = episodes();
  expect(after).toHaveLength(before.length); // renumbered, not duplicated

  const rescueOpener = after.find((e) => e.id === rescueOpenerId)!;
  expect([rescueOpener.seasonNumber, rescueOpener.episodeNumber]).toEqual([3, 1]);
  expect(rescueOpener.absoluteNumber).toBe(42);
  expect(rescueOpener.monitored).toBe(false); // row identity (and its state) kept

  const tybw = after.find((e) => e.id === tybwId)!;
  expect([tybw.seasonNumber, tybw.episodeNumber]).toEqual([4, 3]);
  expect(tybw.absoluteNumber).toBe(66); // still the whole-run number releases use

  // Season rows follow: specials + one per arc.
  const seasons = db
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.seriesId, seriesId))
    .all()
    .map((s) => s.seasonNumber)
    .sort((a, b) => a - b);
  expect(seasons).toEqual([0, 1, 2, 3, 4]);
});

test("switching back to the aired order restores TMDB's numbering", async () => {
  await svc.syncSeasonsAndEpisodes(seriesId, 30984, AIRED_SEASONS, null);
  const eps = episodes();
  expect(eps).toHaveLength(70);
  expect(new Set(eps.map((e) => e.seasonNumber))).toEqual(new Set([0, 1, 2]));
  const last = eps.find((e) => e.tmdbEpisodeId === tmdbEpisodeId(1, 63))!;
  expect([last.seasonNumber, last.episodeNumber]).toEqual([1, 63]);
});

test("an episode TMDB dropped is pruned when nothing is attached to it", async () => {
  const db = getDb();
  db.insert(schema.episodes)
    .values({ seriesId, seasonNumber: 9, episodeNumber: 1, tmdbEpisodeId: 999_999 })
    .run();
  await svc.syncSeasonsAndEpisodes(seriesId, 30984, AIRED_SEASONS, null);
  expect(episodes().some((e) => e.tmdbEpisodeId === 999_999)).toBe(false);
  const seasons = db
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.seriesId, seriesId))
    .all();
  expect(seasons.some((s) => s.seasonNumber === 9)).toBe(false);
});

test("a dropped episode that still holds a file keeps its slot", async () => {
  const db = getDb();
  const file = db
    .insert(schema.episodeFiles)
    .values({
      seriesId,
      relativePath: "Extras/mystery.mkv",
      size: 1,
      quality: { qualityId: 1, revision: { version: 1, real: 0 } },
      dateAdded: new Date(),
    })
    .returning()
    .get();
  const orphan = db
    .insert(schema.episodes)
    .values({
      seriesId,
      seasonNumber: 9,
      episodeNumber: 1,
      tmdbEpisodeId: 888_888,
      episodeFileId: file.id,
    })
    .returning()
    .get();

  await svc.syncSeasonsAndEpisodes(seriesId, 30984, AIRED_SEASONS, null);

  const kept = episodes().find((e) => e.id === orphan.id);
  expect(kept).toBeDefined();
  expect(kept!.episodeFileId).toBe(file.id);
});
