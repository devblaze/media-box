import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the DB at a throwaway dir BEFORE any @/server/db import resolves getDb().
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-jellyfin-sync-"));
process.env.CONFIG_DIR = TMP;

// Replace every HTTP-touching client call with a controllable vi.fn(); keep the
// pure helpers (ticksToSeconds, providerId, JellyfinError) real.
vi.mock("@/server/jellyfin/jellyfin-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/jellyfin/jellyfin-client")>();
  return {
    ...actual,
    getResumeItems: vi.fn(),
    getNextUp: vi.fn(),
    getItem: vi.fn(),
    getSeriesEpisodes: vi.fn(),
    logout: vi.fn(),
  };
});

// The tvdb→tmdb fallback in findSeriesId calls TMDB — never let it hit the network.
vi.mock("@/server/metadata/tmdb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/metadata/tmdb")>();
  return { ...actual, findByTvdbId: vi.fn() };
});

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let client: typeof import("@/server/jellyfin/jellyfin-client");
let tmdb: typeof import("@/server/metadata/tmdb");
let sync: typeof import("@/server/jellyfin/jellyfin-sync");
let ops: typeof import("drizzle-orm");

/** Jellyfin ticks are 100ns units: 10,000,000 per second. */
const ticks = (seconds: number) => seconds * 10_000_000;

let userId: number;
// Distinct tmdb ids per test keep the tests independent of each other.
let movieResume: number; // tmdb 100 — test a
let moviePlayed: number; // tmdb 101 — test b
let movieGuarded: number; // tmdb 102 — test c
let seriesA: number; // tmdb 200 — test e (episode flow)
let epA1: number;
let epA2: number;
let seriesB: number; // tmdb 201, NO tvdbId — test f (tvdb fallback)

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  client = await import("@/server/jellyfin/jellyfin-client");
  tmdb = await import("@/server/metadata/tmdb");
  sync = await import("@/server/jellyfin/jellyfin-sync");
  ops = await import("drizzle-orm");
  const { setSetting } = await import("@/server/settings/settings-service");

  setSetting("jellyfinUrl", "http://jf.test");

  const db = getDb();
  const now = new Date();

  userId = db
    .insert(schema.users)
    .values({ username: "alice", passwordHash: "x", createdAt: now })
    .returning()
    .get().id;

  db.insert(schema.jellyfinLinks)
    .values({
      userId,
      jellyfinUserId: "jf-user-1",
      jellyfinUsername: "alice",
      accessToken: "token-1",
      deviceId: "device-1",
      createdAt: now,
    })
    .run();

  const profileId = db
    .insert(schema.qualityProfiles)
    .values({ name: "HD", cutoffQualityId: 1, items: [{ qualityId: 1 }] })
    .returning()
    .get().id;

  const insMovie = (tmdbId: number, title: string) =>
    db
      .insert(schema.movies)
      .values({
        tmdbId,
        title,
        sortTitle: title.toLowerCase(),
        path: `/movies/${title}`,
        qualityProfileId: profileId,
        addedAt: now,
      })
      .returning()
      .get().id;
  movieResume = insMovie(100, "Inception");
  moviePlayed = insMovie(101, "Interstellar");
  movieGuarded = insMovie(102, "Tenet");

  const insSeries = (tmdbId: number, title: string) =>
    db
      .insert(schema.series)
      .values({
        tmdbId,
        title,
        sortTitle: title.toLowerCase(),
        path: `/tv/${title}`,
        qualityProfileId: profileId,
        isAnime: false,
        addedAt: now,
      })
      .returning()
      .get().id;
  seriesA = insSeries(200, "Severance");
  seriesB = insSeries(201, "Dark"); // tvdbId deliberately unset (fallback test)

  const insEp = (seriesId: number, n: number) =>
    db
      .insert(schema.episodes)
      .values({ seriesId, seasonNumber: 1, episodeNumber: n, title: `Ep ${n}` })
      .returning()
      .get().id;
  epA1 = insEp(seriesA, 1);
  epA2 = insEp(seriesA, 2);
  insEp(seriesB, 1);
});

beforeEach(() => {
  vi.mocked(client.getResumeItems).mockReset().mockResolvedValue({ Items: [] });
  vi.mocked(client.getNextUp).mockReset().mockResolvedValue({ Items: [] });
  vi.mocked(client.getItem).mockReset();
  vi.mocked(client.getSeriesEpisodes).mockReset().mockResolvedValue({ Items: [] });
  vi.mocked(tmdb.findByTvdbId).mockReset();
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function movieRow(movieId: number) {
  const db = getDb();
  return db
    .select()
    .from(schema.watchProgress)
    .where(
      ops.and(eqUser(), ops.eq(schema.watchProgress.movieId, movieId))
    )
    .get();
}

function episodeRow(episodeId: number) {
  const db = getDb();
  return db
    .select()
    .from(schema.watchProgress)
    .where(ops.and(eqUser(), ops.eq(schema.watchProgress.episodeId, episodeId)))
    .get();
}

function eqUser() {
  return ops.eq(schema.watchProgress.userId, userId);
}

function allProgressRows() {
  return getDb().select().from(schema.watchProgress).where(eqUser()).all();
}

function linkRow() {
  return getDb()
    .select()
    .from(schema.jellyfinLinks)
    .where(ops.eq(schema.jellyfinLinks.userId, userId))
    .get()!;
}

// (a) A partially-watched movie mirrors position + duration into watch_progress.
test("movie resume item writes position and duration", async () => {
  vi.mocked(client.getResumeItems).mockResolvedValue({
    Items: [
      {
        Id: "jf-movie-100",
        Type: "Movie",
        ProviderIds: { Tmdb: "100" },
        RunTimeTicks: ticks(6000),
        UserData: {
          PlaybackPositionTicks: ticks(3000),
          Played: false,
          LastPlayedDate: new Date().toISOString(),
        },
      },
    ],
  });

  const result = await sync.syncUser(userId);
  expect(result).toEqual({ moviesSynced: 1, episodesSynced: 0, seriesMatched: 0, skipped: 0 });

  const row = movieRow(movieResume);
  expect(row).toBeDefined();
  expect(row!.positionSeconds).toBe(3000);
  expect(row!.durationSeconds).toBe(6000);
  expect(row!.watched).toBe(false);
});

// (b) A fully-played movie is marked watched; setWatched pins position = duration.
test("movie with Played=true is marked watched", async () => {
  vi.mocked(client.getResumeItems).mockResolvedValue({
    Items: [
      {
        Id: "jf-movie-101",
        Type: "Movie",
        ProviderIds: { Tmdb: "101" },
        RunTimeTicks: ticks(5400),
        UserData: { Played: true, LastPlayedDate: new Date().toISOString() },
      },
    ],
  });

  const result = await sync.syncUser(userId);
  expect(result.moviesSynced).toBe(1);

  const row = movieRow(moviePlayed);
  expect(row).toBeDefined();
  expect(row!.watched).toBe(true);
  // setWatched sets position = duration (a fresh row starts both at 0).
  expect(row!.positionSeconds).toBe(row!.durationSeconds);
});

// (c) Local progress newer than the Jellyfin session must never be clobbered.
test("timestamp guard keeps a newer local row", async () => {
  const db = getDb();
  db.insert(schema.watchProgress)
    .values({
      userId,
      movieId: movieGuarded,
      episodeId: null,
      seriesId: null,
      positionSeconds: 5000,
      durationSeconds: 6000,
      watched: false,
      updatedAt: new Date(), // local state is NOW
    })
    .run();

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  vi.mocked(client.getResumeItems).mockResolvedValue({
    Items: [
      {
        Id: "jf-movie-102",
        Type: "Movie",
        ProviderIds: { Tmdb: "102" },
        RunTimeTicks: ticks(6000),
        UserData: {
          PlaybackPositionTicks: ticks(100),
          Played: false,
          LastPlayedDate: hourAgo.toISOString(),
        },
      },
    ],
  });

  const result = await sync.syncUser(userId);
  expect(result.moviesSynced).toBe(0);

  const row = movieRow(movieGuarded);
  expect(row!.positionSeconds).toBe(5000); // untouched
  expect(row!.durationSeconds).toBe(6000);
});

// (d) A movie that isn't in the library is counted as skipped, nothing written.
test("unmatched movie increments skipped and writes no row", async () => {
  const before = allProgressRows().length;
  vi.mocked(client.getResumeItems).mockResolvedValue({
    Items: [
      {
        Id: "jf-movie-999",
        Type: "Movie",
        ProviderIds: { Tmdb: "999999" },
        RunTimeTicks: ticks(6000),
        UserData: {
          PlaybackPositionTicks: ticks(1000),
          LastPlayedDate: new Date().toISOString(),
        },
      },
    ],
  });

  const result = await sync.syncUser(userId);
  expect(result.skipped).toBe(1);
  expect(result.moviesSynced).toBe(0);
  expect(allProgressRows().length).toBe(before); // no new rows
});

// (e) A resume episode pulls the whole series' per-episode watch state.
test("episode resume syncs full series watch state with seriesId", async () => {
  const nowIso = new Date().toISOString();
  vi.mocked(client.getResumeItems).mockResolvedValue({
    Items: [
      {
        Id: "jf-ep-resume",
        Type: "Episode",
        SeriesId: "jf-series-1",
        ParentIndexNumber: 1,
        IndexNumber: 2,
        UserData: { PlaybackPositionTicks: ticks(600), LastPlayedDate: nowIso },
      },
    ],
  });
  vi.mocked(client.getItem).mockResolvedValue({
    Id: "jf-series-1",
    Type: "Series",
    ProviderIds: { Tmdb: "200" },
  });
  vi.mocked(client.getSeriesEpisodes).mockResolvedValue({
    Items: [
      {
        Id: "jf-s1e1",
        Type: "Episode",
        ParentIndexNumber: 1,
        IndexNumber: 1,
        RunTimeTicks: ticks(1500),
        UserData: { Played: true, LastPlayedDate: nowIso },
      },
      {
        Id: "jf-s1e2",
        Type: "Episode",
        ParentIndexNumber: 1,
        IndexNumber: 2,
        RunTimeTicks: ticks(1500),
        UserData: { PlaybackPositionTicks: ticks(600), Played: false, LastPlayedDate: nowIso },
      },
    ],
  });

  const result = await sync.syncUser(userId);
  expect(result.seriesMatched).toBe(1);
  expect(result.episodesSynced).toBe(2);
  expect(result.moviesSynced).toBe(0);
  expect(result.skipped).toBe(0);
  expect(vi.mocked(client.getItem)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(client.getSeriesEpisodes).mock.calls[0][1]).toBe("jf-series-1");

  const e1 = episodeRow(epA1);
  expect(e1).toBeDefined();
  expect(e1!.watched).toBe(true);
  expect(e1!.seriesId).toBe(seriesA); // service derives seriesId for episode rows

  const e2 = episodeRow(epA2);
  expect(e2).toBeDefined();
  expect(e2!.watched).toBe(false);
  expect(e2!.positionSeconds).toBe(600);
  expect(e2!.durationSeconds).toBe(1500);
  expect(e2!.seriesId).toBe(seriesA);
});

// (f) A series with only a Tvdb id resolves through TMDB's find endpoint.
test("tvdb fallback matches a series without a stored tvdbId", async () => {
  vi.mocked(client.getResumeItems).mockResolvedValue({
    Items: [
      {
        Id: "jf-ep-dark",
        Type: "Episode",
        SeriesId: "jf-series-2",
        ParentIndexNumber: 1,
        IndexNumber: 1,
        UserData: { PlaybackPositionTicks: ticks(60), LastPlayedDate: new Date().toISOString() },
      },
    ],
  });
  vi.mocked(client.getItem).mockResolvedValue({
    Id: "jf-series-2",
    Type: "Series",
    ProviderIds: { Tvdb: "76543" }, // no Tmdb id on the Jellyfin side
  });
  vi.mocked(tmdb.findByTvdbId).mockResolvedValue({
    tv_results: [{ id: 201, name: "Dark" }], // resolves to the fixture's tmdbId
  });

  const result = await sync.syncUser(userId);
  expect(vi.mocked(tmdb.findByTvdbId)).toHaveBeenCalledWith(76543);
  expect(result.seriesMatched).toBe(1);
  expect(result.skipped).toBe(0);
});

// (g) A failing Jellyfin call surfaces as a thrown error + recorded lastSyncError.
test("client failure rethrows and records lastSyncError on the link", async () => {
  vi.mocked(client.getResumeItems).mockRejectedValue(
    new client.JellyfinError("Could not reach Jellyfin at http://jf.test: down")
  );

  await expect(sync.syncUser(userId)).rejects.toThrow("Could not reach Jellyfin");

  const link = linkRow();
  expect(link.lastSyncError).toBe("Could not reach Jellyfin at http://jf.test: down");
  expect(link.lastSyncAt).toBeInstanceOf(Date);
});
