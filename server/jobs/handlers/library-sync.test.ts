/**
 * The library sync, end to end on a throwaway library: titles that exist only on
 * disk join the library when something identifies them exactly, a title whose
 * files sit in a different folder than recorded gets relinked, and a title with
 * no id is left for a person to confirm.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-sync-"));
process.env.CONFIG_DIR = TMP;
const MOVIES = path.join(TMP, "movies");
const TV = path.join(TMP, "tv");

// TMDB, answered from a table: just enough for id resolution and adding a movie.
const MOVIES_BY_ID: Record<number, { title: string; year: number }> = {
  550: { title: "Fight Club", year: 1999 },
  603: { title: "The Matrix", year: 1999 },
};
vi.mock("@/server/metadata/tmdb", () => {
  const summary = (id: number) => {
    const m = MOVIES_BY_ID[id];
    if (!m) throw new Error(`no movie ${id}`);
    return { id, title: m.title, release_date: `${m.year}-01-01`, overview: "", poster_path: null };
  };
  return {
    getMovieById: async (id: number) => summary(id),
    getMovie: async (id: number) => ({ ...summary(id), status: "Released", runtime: 120 }),
    getTvById: async (id: number) => ({
      id,
      name: "Some Show",
      first_air_date: "2010-01-01",
      overview: "",
    }),
    findByImdbId: async () => ({ movie_results: [], tv_results: [] }),
    findByTvdbId: async () => ({ movie_results: [], tv_results: [] }),
    searchMovie: async () => ({ results: [] }),
    searchTv: async () => ({ results: [] }),
    posterUrl: () => null,
    isAnimeMeta: () => false,
  };
});
// No Jellyfin here: identification comes from .nfo files and folder names.
vi.mock("@/server/jellyfin/jellyfin-service", () => ({
  getJellyfinUrl: () => "",
  getAllLinks: () => [],
  connectionFor: () => ({}),
}));

function video(rel: string): string {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
  fs.truncateSync(abs, 200 * 1024 * 1024); // sparse
  return abs;
}

let getDb: typeof import("@/server/db").getDb;
let schema: typeof import("@/server/db").schema;
let librarySyncHandler: typeof import("./library-sync").librarySyncHandler;
let showId: number;
let matrixId: number;

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  ({ librarySyncHandler } = await import("./library-sync"));
  const db = getDb();

  const profile = db
    .insert(schema.qualityProfiles)
    .values({ name: "Any", cutoffQualityId: 3, items: [{ qualityId: 3, allowed: true }] })
    .returning()
    .get();
  db.insert(schema.rootFolders).values({ path: MOVIES, mediaType: "movies" }).run();
  db.insert(schema.rootFolders).values({ path: TV, mediaType: "series" }).run();

  // On disk only, identified by an .nfo Jellyfin wrote.
  video("movies/Fight Club (1999)/Fight Club (1999).mkv");
  fs.writeFileSync(
    path.join(MOVIES, "Fight Club (1999)", "movie.nfo"),
    '<movie><uniqueid type="tmdb">550</uniqueid></movie>'
  );
  // In the library, but recorded at a folder that doesn't exist.
  video("movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.1080p.mkv");
  matrixId = db
    .insert(schema.movies)
    .values({
      tmdbId: 603,
      title: "The Matrix",
      sortTitle: "matrix",
      year: 1999,
      path: "/old/box/movies/The Matrix (1999)",
      qualityProfileId: profile.id,
      monitored: true,
      addedAt: new Date(),
    })
    .returning()
    .get().id;
  // No id anywhere: a guess, so it waits for Library Import.
  video("movies/Mystery Thing (2021)/Mystery Thing (2021).mkv");

  // A series in the library with no files linked; its folder has a tvshow.nfo.
  video("tv/Some Show/Season 01/Some Show - S01E01.mkv");
  fs.writeFileSync(
    path.join(TV, "Some Show", "tvshow.nfo"),
    "<tvshow><tmdbid>4242</tmdbid></tvshow>"
  );
  showId = db
    .insert(schema.series)
    .values({
      tmdbId: 4242,
      title: "Some Show",
      sortTitle: "some show",
      year: 2010,
      path: "/old/box/tv/Some Show",
      qualityProfileId: profile.id,
      addedAt: new Date(),
    })
    .returning()
    .get().id;
  db.insert(schema.episodes)
    .values({ seriesId: showId, seasonNumber: 1, episodeNumber: 1, title: "Pilot" })
    .run();
});

describe("library sync", () => {
  test("adopts what's identified, relinks what moved, leaves guesses alone", async () => {
    const summary = await librarySyncHandler();
    expect(summary).toMatch(/added 1, relinked 2/);
    const db = getDb();

    const movies = db.select().from(schema.movies).all();
    const fightClub = movies.find((m) => m.tmdbId === 550);
    expect(fightClub).toMatchObject({
      path: path.join(MOVIES, "Fight Club (1999)"),
      monitored: false,
    });
    expect(fightClub?.movieFileId).not.toBeNull();
    expect(movies.some((m) => m.title.includes("Mystery"))).toBe(false);

    const matrix = movies.find((m) => m.id === matrixId);
    expect(matrix?.path).toBe(path.join(MOVIES, "The Matrix (1999) {tmdb-603}"));
    expect(matrix?.movieFileId).not.toBeNull();

    const show = db
      .select()
      .from(schema.series)
      .all()
      .find((s) => s.id === showId);
    expect(show?.path).toBe(path.join(TV, "Some Show"));
    const pilot = db
      .select()
      .from(schema.episodes)
      .all()
      .find((e) => e.seriesId === showId);
    expect(pilot?.episodeFileId).not.toBeNull();
  });

  test("a second run finds nothing new", async () => {
    expect(await librarySyncHandler()).toMatch(/added 0, relinked 0/);
  });
});
