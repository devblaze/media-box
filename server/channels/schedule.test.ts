import { afterAll, beforeAll, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the DB at a throwaway dir BEFORE any @/server/db import resolves getDb().
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-channels-"));
process.env.CONFIG_DIR = TMP;
process.env.NODE_ENV = "test";

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let engine: typeof import("@/server/channels/schedule");

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  engine = await import("@/server/channels/schedule");
  const { eq } = await import("drizzle-orm");

  const db = getDb();
  const now = new Date();
  const qty = { qualityId: 1 };

  const profile = db
    .insert(schema.qualityProfiles)
    .values({ name: "HD", cutoffQualityId: 1, items: [qty] })
    .returning()
    .get();

  // --- Series: S01E01 (have) · S01E02 (MISSING) · S01E03 (have) ---
  const series = db
    .insert(schema.series)
    .values({
      tmdbId: 1,
      title: "Supernatural",
      sortTitle: "supernatural",
      year: 2005,
      path: "/tv/Supernatural",
      qualityProfileId: profile.id,
      isAnime: false,
      addedAt: now,
    })
    .returning()
    .get();
  db.insert(schema.seasons).values({ seriesId: series.id, seasonNumber: 1 }).run();

  const newEpFile = () =>
    db
      .insert(schema.episodeFiles)
      .values({
        seriesId: series.id,
        relativePath: "ep.mkv",
        size: 1,
        quality: qty,
        dateAdded: now,
        mediaInfo: { container: "mkv", durationSec: 1800 },
      })
      .returning()
      .get().id;

  const insEp = (n: number, fileId: number | null) =>
    db
      .insert(schema.episodes)
      .values({ seriesId: series.id, seasonNumber: 1, episodeNumber: n, title: `Ep ${n}`, runtime: 30, episodeFileId: fileId })
      .run();
  insEp(1, newEpFile());
  insEp(2, null); // missing on purpose
  insEp(3, newEpFile());

  // --- Movie franchise: Iron Man 2008 · 2010 · 2013 (all have files) ---
  const insMovie = (tmdbId: number, title: string, year: number) => {
    const m = db
      .insert(schema.movies)
      .values({
        tmdbId,
        title,
        sortTitle: title.toLowerCase(),
        year,
        runtime: 120,
        collectionTmdbId: 131292,
        collectionName: "Iron Man Collection",
        path: `/movies/${title}`,
        qualityProfileId: profile.id,
        addedAt: now,
      })
      .returning()
      .get();
    const fileId = db
      .insert(schema.movieFiles)
      .values({ movieId: m.id, relativePath: "m.mkv", size: 1, quality: qty, dateAdded: now, mediaInfo: { container: "mkv", durationSec: 3600 } })
      .returning()
      .get().id;
    db.update(schema.movies).set({ movieFileId: fileId }).where(eq(schema.movies.id, m.id)).run();
  };
  insMovie(10, "Iron Man", 2008);
  insMovie(11, "Iron Man 2", 2010);
  insMovie(12, "Iron Man 3", 2013);

  // Deterministic picks: pickRandom -> index 0, franchise-continue always taken.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("series channel plays episodes in order, skipping the missing one", () => {
  const guide = engine.getGuide("series", 4);
  const labels = guide.programs.map((p) => p.episodeLabel);
  // E01, then (E02 missing → skip) E03, then wrap to E01, E03 ...
  expect(labels.slice(0, 4)).toEqual(["S01E01", "S01E03", "S01E01", "S01E03"]);

  const now = engine.getNowAndNext("series", 2);
  expect(now.current?.target.type).toBe("episode");
  expect(now.current?.offsetSeconds).toBe(0);
});

test("movies channel plays a franchise in release-year order", () => {
  const guide = engine.getGuide("movies", 4);
  const titles = guide.programs.map((p) => p.title);
  expect(titles.slice(0, 4)).toEqual([
    "Iron Man (2008)",
    "Iron Man 2 (2010)",
    "Iron Man 3 (2013)",
    "Iron Man (2008)",
  ]);
});

test("empty anime channel reports nothing playing", () => {
  const now = engine.getNowAndNext("anime", 3);
  expect(now.current).toBeNull();
  expect(now.upNext).toEqual([]);
});
