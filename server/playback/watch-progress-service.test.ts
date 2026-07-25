import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the DB at a throwaway dir BEFORE any @/server/db import resolves getDb().
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-progress-"));
process.env.CONFIG_DIR = TMP;

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let svc: typeof import("@/server/playback/watch-progress-service");

const USER = 1;
let movieAId: number;
let movieBId: number;
let seriesId: number;
const episodeIds: number[] = []; // S01E01..E03

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  svc = await import("@/server/playback/watch-progress-service");
  const { eq } = await import("drizzle-orm");

  const db = getDb();
  const now = new Date();
  const qty = { qualityId: 1 };

  db.insert(schema.users)
    .values({ username: "tester", passwordHash: "x:y", createdAt: now })
    .run();

  const profile = db
    .insert(schema.qualityProfiles)
    .values({ name: "HD", cutoffQualityId: 1, items: [qty] })
    .returning()
    .get();

  const insMovie = (tmdbId: number, title: string) => {
    const m = db
      .insert(schema.movies)
      .values({
        tmdbId,
        title,
        sortTitle: title.toLowerCase(),
        year: 2020,
        runtime: 120,
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
    return m.id;
  };
  movieAId = insMovie(100, "Movie A");
  movieBId = insMovie(101, "Movie B");

  const series = db
    .insert(schema.series)
    .values({
      tmdbId: 200,
      title: "Show",
      sortTitle: "show",
      year: 2021,
      path: "/tv/Show",
      qualityProfileId: profile.id,
      isAnime: false,
      addedAt: now,
    })
    .returning()
    .get();
  seriesId = series.id;
  db.insert(schema.seasons).values({ seriesId, seasonNumber: 1 }).run();
  for (let n = 1; n <= 3; n++) {
    const fileId = db
      .insert(schema.episodeFiles)
      .values({ seriesId, relativePath: `e${n}.mkv`, size: 1, quality: qty, dateAdded: now, mediaInfo: { container: "mkv", durationSec: 1800 } })
      .returning()
      .get().id;
    const ep = db
      .insert(schema.episodes)
      .values({ seriesId, seasonNumber: 1, episodeNumber: n, title: `Ep ${n}`, runtime: 30, episodeFileId: fileId })
      .returning()
      .get();
    episodeIds.push(ep.id);
  }
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function clearProgress() {
  getDb().delete(schema.watchProgress).run();
}

function progressRow(target: { movieId?: number; episodeId?: number }) {
  const rows = getDb().select().from(schema.watchProgress).all();
  return rows.find(
    (r) =>
      r.userId === USER &&
      (target.movieId ? r.movieId === target.movieId : r.episodeId === target.episodeId)
  );
}

describe("upsertProgress", () => {
  it("ignores blips under 10 seconds and records real progress", () => {
    clearProgress();
    svc.upsertProgress(USER, { movieId: movieAId, positionSeconds: 5, durationSeconds: 3600 });
    expect(progressRow({ movieId: movieAId })).toBeUndefined();
    svc.upsertProgress(USER, { movieId: movieAId, positionSeconds: 300, durationSeconds: 3600 });
    const row = progressRow({ movieId: movieAId });
    expect(row?.positionSeconds).toBe(300);
    expect(row?.watched).toBe(false);
  });

  it("flips to watched at 90% and stays sticky when rewatching", () => {
    clearProgress();
    svc.upsertProgress(USER, { movieId: movieAId, positionSeconds: 3400, durationSeconds: 3600 });
    expect(progressRow({ movieId: movieAId })?.watched).toBe(true);
    // Restarting from the top must not clear the watched flag.
    svc.upsertProgress(USER, { movieId: movieAId, positionSeconds: 60, durationSeconds: 3600 });
    const row = progressRow({ movieId: movieAId });
    expect(row?.watched).toBe(true);
    expect(row?.positionSeconds).toBe(60);
  });

  it("derives seriesId for episode progress", () => {
    clearProgress();
    svc.upsertProgress(USER, { episodeId: episodeIds[0], positionSeconds: 600, durationSeconds: 1800 });
    expect(progressRow({ episodeId: episodeIds[0] })?.seriesId).toBe(seriesId);
  });
});

describe("setWatched (single and bulk)", () => {
  it("marks a movie watched with position = duration", () => {
    clearProgress();
    svc.setWatched(USER, { movieId: movieAId }, true);
    const row = progressRow({ movieId: movieAId });
    expect(row?.watched).toBe(true);
    expect(row?.positionSeconds).toBe(row?.durationSeconds);
  });

  it("bulk loop marks mixed targets watched (the /watched items form)", () => {
    clearProgress();
    // The route's bulk form is a loop over setWatched — same contract.
    const items = [{ movieId: movieAId }, { movieId: movieBId }, { episodeId: episodeIds[0] }];
    for (const t of items) svc.setWatched(USER, t, true);
    expect(progressRow({ movieId: movieAId })?.watched).toBe(true);
    expect(progressRow({ movieId: movieBId })?.watched).toBe(true);
    expect(progressRow({ episodeId: episodeIds[0] })?.watched).toBe(true);
  });

  it("marks a whole series watched and can undo it", () => {
    clearProgress();
    svc.setWatched(USER, { seriesId }, true);
    for (const id of episodeIds) expect(progressRow({ episodeId: id })?.watched).toBe(true);
    svc.setWatched(USER, { seriesId }, false);
    for (const id of episodeIds) expect(progressRow({ episodeId: id })?.watched).toBe(false);
  });
});

describe("continueWatching", () => {
  it("drops movies marked watched and surfaces the series' next episode", () => {
    clearProgress();
    // In-progress movie + fully-watched episode 1.
    svc.upsertProgress(USER, { movieId: movieAId, positionSeconds: 900, durationSeconds: 3600 });
    svc.setWatched(USER, { episodeId: episodeIds[0] }, true);

    let items = svc.continueWatching(USER);
    const movie = items.find((i) => i.kind === "movie");
    expect(movie?.movieId).toBe(movieAId);
    const episode = items.find((i) => i.kind === "episode");
    // E01 watched → the row offers E02 next.
    expect(episode?.episodeId).toBe(episodeIds[1]);
    expect(episode?.positionSeconds).toBe(0);

    // Bulk-marking the visible items watched clears the movie and advances the series.
    svc.setWatched(USER, { movieId: movieAId }, true);
    svc.setWatched(USER, { episodeId: episodeIds[1] }, true);
    items = svc.continueWatching(USER);
    expect(items.find((i) => i.kind === "movie")).toBeUndefined();
    expect(items.find((i) => i.kind === "episode")?.episodeId).toBe(episodeIds[2]);

    // Finishing the series removes it entirely.
    svc.setWatched(USER, { episodeId: episodeIds[2] }, true);
    expect(svc.continueWatching(USER)).toHaveLength(0);
  });

  it("resumes a partially-watched episode instead of skipping ahead", () => {
    clearProgress();
    svc.upsertProgress(USER, { episodeId: episodeIds[1], positionSeconds: 500, durationSeconds: 1800 });
    const items = svc.continueWatching(USER);
    expect(items).toHaveLength(1);
    expect(items[0].episodeId).toBe(episodeIds[1]);
    expect(items[0].positionSeconds).toBe(500);
  });
});
