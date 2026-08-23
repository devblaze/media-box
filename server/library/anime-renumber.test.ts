/**
 * End-to-end for the Bleach problem: an anime whose files on disk are numbered
 * TVDB-style (Season 07/… S07E20) while TMDB airs the show as two enormous
 * seasons. Before the show is pinned to TMDB's "TVDB Order" grouping those files
 * land on whatever S02Exx episode happens to share the number; after it, every
 * file sits on the episode it actually is.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-renumber-"));
process.env.CONFIG_DIR = TMP;
const LIBRARY = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-bleach-"));

const MB = 1024 * 1024;

/** Aired shape: one 63-episode run, a 25-episode sequel season, 2 specials. */
const AIRED_SEASONS = [
  { season_number: 0, episode_count: 2 },
  { season_number: 1, episode_count: 63 },
  { season_number: 2, episode_count: 25 },
];

const epId = (season: number, episode: number) => season * 10_000 + episode;

/** [group order (= season), native season, first native episode, last]. */
const ARCS: [number, number, number, number][] = [
  [1, 1, 1, 20],
  [2, 1, 21, 41],
  [3, 1, 42, 63],
  [4, 2, 1, 25],
  [0, 0, 1, 2],
];

vi.mock("@/server/metadata/tmdb", () => ({
  getTv: async () => ({
    id: 30984,
    name: "Bleach",
    first_air_date: "2004-10-05",
    status: "Returning Series",
    networks: [{ name: "TV Tokyo", origin_country: "JP" }],
    origin_country: ["JP"],
    episode_run_time: [24],
    number_of_seasons: 2,
    seasons: AIRED_SEASONS,
    external_ids: {},
  }),
  getTvSeason: async (_id: number, season: number) => ({
    season_number: season,
    episodes: Array.from(
      { length: AIRED_SEASONS.find((s) => s.season_number === season)!.episode_count },
      (_, i) => ({
        id: epId(season, i + 1),
        season_number: season,
        episode_number: i + 1,
        name: `Aired S${season}E${i + 1}`,
        air_date: "2004-10-05",
        runtime: 24,
      })
    ),
  }),
  getTvEpisodeGroup: async () => ({
    id: "tvdb",
    name: "TVDB Order",
    type: 1,
    groups: ARCS.map(([order, season, from, to]) => ({
      id: `g${order}`,
      name: order === 0 ? "Specials" : `Arc ${order}`,
      order,
      episodes: Array.from({ length: to - from + 1 }, (_, i) => ({
        id: epId(season, from + i),
        season_number: season,
        episode_number: from + i,
        order: i,
        name: `Aired S${season}E${from + i}`,
        air_date: "2004-10-05",
        runtime: 24,
      })),
    })),
  }),
  getTvEpisodeGroups: async () => ({
    results: [
      { id: "tvdb", name: "TVDB Order", type: 1, group_count: 5, episode_count: 90 },
    ],
  }),
}));

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let svc: typeof import("@/server/library/series-service");
let scanSeries: typeof import("@/server/library/disk-scanner").scanSeries;
let eq: typeof import("drizzle-orm").eq;
let seriesId: number;

/** The library as Sonarr left it: TVDB season folders plus a flat absolute run. */
const FILES = [
  "Season 2/Bleach - S02E21 - Reunion HDTV-720p.mkv", // absolute 41
  "Season 3/Bleach - S03E01 - The Rescue HDTV-720p.mkv", // absolute 42
  "Season 4/Bleach - S04E03 - Sequel WEBDL-1080p.mkv", // absolute 66 (native S02E03)
  "Season 4/Bleach - S04E22 - Later Sequel WEBDL-1080p.mkv", // absolute 85
  "Bleach - s01e050.mkv", // flat absolute numbering → arc 3, episode 9
];

function file(rel: string) {
  const abs = path.join(LIBRARY, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
  fs.truncateSync(abs, 60 * MB); // sparse: over the scanner's 50 MB floor, no real disk
}

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  svc = await import("@/server/library/series-service");
  ({ scanSeries } = await import("@/server/library/disk-scanner"));
  ({ eq } = await import("drizzle-orm"));

  for (const rel of FILES) file(rel);

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
      path: LIBRARY,
      qualityProfileId: profile.id,
      isAnime: true,
      addedAt: new Date(),
    })
    .returning()
    .get().id;

  await svc.syncSeasonsAndEpisodes(seriesId, 30984, AIRED_SEASONS, null);
  await scanSeries(seriesId);
}, 60_000);

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(LIBRARY, { recursive: true, force: true });
});

/** relativePath → "SxxEyy #absolute" of the episode it is linked to. */
function mapping(): Map<string, string> {
  const db = getDb();
  const files = db
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.seriesId, seriesId))
    .all();
  const episodes = db
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all();
  const out = new Map<string, string>();
  for (const f of files) {
    const ep = episodes.find((e) => e.episodeFileId === f.id);
    if (!ep) continue;
    out.set(
      f.relativePath,
      `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")} #${ep.absoluteNumber}`
    );
  }
  return out;
}

test("on TMDB's aired order the TVDB-numbered files land on the wrong episodes", () => {
  const m = mapping();
  // "Season 2/… S02E21" is the 41st episode of the show. Aired-order season 2 is
  // the SEQUEL series, so the file lands on its 21st episode — number 84. The bug.
  expect(m.get("Season 2/Bleach - S02E21 - Reunion HDTV-720p.mkv")).toBe("S02E21 #84");
  // Seasons 3 and 4 don't exist in the aired ordering at all, so those files are
  // simply not in the library.
  expect(m.has("Season 3/Bleach - S03E01 - The Rescue HDTV-720p.mkv")).toBe(false);
  expect(m.has("Season 4/Bleach - S04E03 - Sequel WEBDL-1080p.mkv")).toBe(false);
  // The flat absolute file happens to be right here — aired S01 IS the absolute run.
  expect(m.get("Bleach - s01e050.mkv")).toBe("S01E50 #50");
});

test("after switching to the TVDB grouping every file sits on the right episode", async () => {
  await svc.setEpisodeOrdering(seriesId, "tvdb");

  const m = mapping();
  expect(m.get("Season 2/Bleach - S02E21 - Reunion HDTV-720p.mkv")).toBe("S02E21 #41");
  expect(m.get("Season 3/Bleach - S03E01 - The Rescue HDTV-720p.mkv")).toBe("S03E01 #42");
  expect(m.get("Season 4/Bleach - S04E03 - Sequel WEBDL-1080p.mkv")).toBe("S04E03 #66");
  expect(m.get("Season 4/Bleach - S04E22 - Later Sequel WEBDL-1080p.mkv")).toBe("S04E22 #85");
  // "s01e050" is absolute 50 — past the 20 episodes of TVDB season 1, so it is
  // read as an absolute number and placed in arc 3 (42–63) as its 9th episode.
  expect(m.get("Bleach - s01e050.mkv")).toBe("S03E09 #50");
  expect(m.size).toBe(FILES.length);
});

test("the episodes now carry the absolute numbers releases are named with", () => {
  const db = getDb();
  const episodes = db
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all();
  const at = (season: number, episode: number) =>
    episodes.find((e) => e.seasonNumber === season && e.episodeNumber === episode)!;

  expect(at(2, 21).absoluteNumber).toBe(41);
  expect(at(3, 1).absoluteNumber).toBe(42);
  expect(at(4, 3).absoluteNumber).toBe(66); // the number a fansub release would use
  expect(at(4, 22).absoluteNumber).toBe(85);
  expect(at(3, 9).absoluteNumber).toBe(50);

  // Seasons are the arc list, not TMDB's two.
  const seasons = db
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.seriesId, seriesId))
    .all()
    .map((s) => s.seasonNumber)
    .sort((a, b) => a - b);
  expect(seasons).toEqual([0, 1, 2, 3, 4]);
});

test("re-running the scan is a no-op — no duplicate file records", async () => {
  const before = mapping();
  await scanSeries(seriesId);
  expect(mapping()).toEqual(before);
  const files = getDb()
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.seriesId, seriesId))
    .all();
  expect(files).toHaveLength(FILES.length);
});
