/**
 * DB-backed tests for `applyMonitorMode` — in particular the specials
 * (season 0) preservation rule: an explicit opt-in on a special must survive
 * mode changes, while "none" still clears everything.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the DB at a throwaway dir BEFORE any @/server/db import resolves getDb().
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-series-"));
process.env.CONFIG_DIR = TMP;

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let svc: typeof import("@/server/library/series-service");
let and: typeof import("drizzle-orm").and;
let eq: typeof import("drizzle-orm").eq;

const NOW = new Date("2026-01-01T12:00:00Z");
const PAST = new Date("2025-06-01T20:00:00Z");
const FUTURE = new Date("2026-06-01T20:00:00Z");

let seriesId: number;

beforeAll(async () => {
  // Freeze ONLY Date: `applyMonitorMode`'s "future" mode compares each episode's
  // airDateUtc against Date.now(). (Timers stay real — async imports need them.)
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  svc = await import("@/server/library/series-service");
  ({ and, eq } = await import("drizzle-orm"));

  const db = getDb();
  const profile = db
    .insert(schema.qualityProfiles)
    .values({ name: "HD", cutoffQualityId: 1, items: [{ qualityId: 1 }] })
    .returning()
    .get();

  const s = db
    .insert(schema.series)
    .values({
      tmdbId: 1,
      title: "Example Show",
      sortTitle: "example show",
      year: 2020,
      path: "/tv/Example Show",
      qualityProfileId: profile.id,
      isAnime: false,
      addedAt: NOW,
    })
    .returning()
    .get();
  seriesId = s.id;

  for (const n of [0, 1, 2]) {
    db.insert(schema.seasons).values({ seriesId, seasonNumber: n }).run();
  }

  const insEp = (
    season: number,
    ep: number,
    airDateUtc: Date | null,
    monitored: boolean
  ) =>
    db
      .insert(schema.episodes)
      .values({ seriesId, seasonNumber: season, episodeNumber: ep, title: `S${season}E${ep}`, airDateUtc, monitored })
      .run();

  // Specials: E1 explicitly opted-in, E2 not.
  insEp(0, 1, PAST, true);
  insEp(0, 2, PAST, false);
  // Season 1: one aired, one upcoming, one with no air date (TBA).
  insEp(1, 1, PAST, true);
  insEp(1, 2, FUTURE, true);
  insEp(1, 3, null, true);
  // Season 2: fully aired.
  insEp(2, 1, PAST, true);
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- read-back helpers ----

const epMonitored = (season: number, ep: number): boolean =>
  getDb()
    .select({ monitored: schema.episodes.monitored })
    .from(schema.episodes)
    .where(
      and(
        eq(schema.episodes.seriesId, seriesId),
        eq(schema.episodes.seasonNumber, season),
        eq(schema.episodes.episodeNumber, ep)
      )
    )
    .get()!.monitored;

const seasonMonitored = (season: number): boolean =>
  getDb()
    .select({ monitored: schema.seasons.monitored })
    .from(schema.seasons)
    .where(and(eq(schema.seasons.seriesId, seriesId), eq(schema.seasons.seasonNumber, season)))
    .get()!.monitored;

const seriesRow = () =>
  getDb().select().from(schema.series).where(eq(schema.series.id, seriesId)).get()!;

/** Force every episode's flag to a known state so each test is order-independent. */
function setFlags(flags: Record<string, boolean>) {
  const db = getDb();
  for (const [key, monitored] of Object.entries(flags)) {
    const [season, ep] = key.split(":").map(Number);
    db.update(schema.episodes)
      .set({ monitored })
      .where(
        and(
          eq(schema.episodes.seriesId, seriesId),
          eq(schema.episodes.seasonNumber, season),
          eq(schema.episodes.episodeNumber, ep)
        )
      )
      .run();
  }
}

test('"all" monitors every regular episode but PRESERVES season-0 flags', () => {
  // Regulars all off, specials split — "all" must flip regulars on and leave season 0 as-is.
  setFlags({ "0:1": true, "0:2": false, "1:1": false, "1:2": false, "1:3": false, "2:1": false });

  svc.applyMonitorMode(seriesId, "all");

  expect(epMonitored(0, 1)).toBe(true); // explicit specials opt-in survives
  expect(epMonitored(0, 2)).toBe(false); // never auto-monitored
  expect(epMonitored(1, 1)).toBe(true);
  expect(epMonitored(1, 2)).toBe(true);
  expect(epMonitored(1, 3)).toBe(true);
  expect(epMonitored(2, 1)).toBe(true);

  // A season is monitored iff it contains a monitored episode.
  expect(seasonMonitored(0)).toBe(true); // via the opted-in special
  expect(seasonMonitored(1)).toBe(true);
  expect(seasonMonitored(2)).toBe(true);

  expect(seriesRow().monitored).toBe(true);
  expect(seriesRow().monitorMode).toBe("all");
});

test('"all" with no specials opt-in leaves season 0 unmonitored', () => {
  setFlags({ "0:1": false, "0:2": false, "1:1": false, "1:2": false, "1:3": false, "2:1": false });

  svc.applyMonitorMode(seriesId, "all");

  expect(epMonitored(0, 1)).toBe(false);
  expect(epMonitored(0, 2)).toBe(false);
  expect(seasonMonitored(0)).toBe(false);
  expect(seasonMonitored(1)).toBe(true);
});

test('"none" clears everything — including the specials opt-in', () => {
  setFlags({ "0:1": true, "0:2": false, "1:1": true, "1:2": true, "1:3": true, "2:1": true });

  svc.applyMonitorMode(seriesId, "none");

  for (const [se, ep] of [[0, 1], [0, 2], [1, 1], [1, 2], [1, 3], [2, 1]] as const) {
    expect(epMonitored(se, ep), `S${se}E${ep}`).toBe(false);
  }
  expect(seasonMonitored(0)).toBe(false);
  expect(seasonMonitored(1)).toBe(false);
  expect(seasonMonitored(2)).toBe(false);
  expect(seriesRow().monitored).toBe(false);
  expect(seriesRow().monitorMode).toBe("none");
});

test('"future" monitors only unaired/TBA regulars and still preserves season 0', () => {
  setFlags({ "0:1": true, "0:2": false, "1:1": true, "1:2": false, "1:3": false, "2:1": true });

  svc.applyMonitorMode(seriesId, "future");

  expect(epMonitored(0, 1)).toBe(true); // preserved opt-in
  expect(epMonitored(0, 2)).toBe(false);
  expect(epMonitored(1, 1)).toBe(false); // aired in the past
  expect(epMonitored(1, 2)).toBe(true); // airs after the frozen "now"
  expect(epMonitored(1, 3)).toBe(true); // no air date → treated as upcoming
  expect(epMonitored(2, 1)).toBe(false); // aired

  expect(seasonMonitored(0)).toBe(true);
  expect(seasonMonitored(1)).toBe(true);
  expect(seasonMonitored(2)).toBe(false);
  expect(seriesRow().monitored).toBe(true);
  expect(seriesRow().monitorMode).toBe("future");
});
