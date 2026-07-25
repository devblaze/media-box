import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the DB at a throwaway dir BEFORE any @/server/db import resolves getDb().
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-activity-"));
process.env.CONFIG_DIR = TMP;

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let svc: typeof import("@/server/users/user-activity-service");

let sharerId: number;
let privateId: number;
let movieId: number;

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  svc = await import("@/server/users/user-activity-service");
  const { eq } = await import("drizzle-orm");

  const db = getDb();
  const now = new Date();
  const qty = { qualityId: 1 };

  sharerId = db
    .insert(schema.users)
    .values({ username: "sharer", passwordHash: "x:y", shareStreamingActivity: true, createdAt: now })
    .returning()
    .get().id;
  privateId = db
    .insert(schema.users)
    .values({ username: "private", passwordHash: "x:y", createdAt: now })
    .returning()
    .get().id;

  const profile = db
    .insert(schema.qualityProfiles)
    .values({ name: "HD", cutoffQualityId: 1, items: [qty] })
    .returning()
    .get();
  const m = db
    .insert(schema.movies)
    .values({
      tmdbId: 900,
      title: "Stream Test",
      sortTitle: "stream test",
      year: 2020,
      runtime: 120,
      path: "/movies/Stream Test",
      qualityProfileId: profile.id,
      addedAt: now,
    })
    .returning()
    .get();
  movieId = m.id;
  const fileId = db
    .insert(schema.movieFiles)
    .values({ movieId, relativePath: "m.mkv", size: 1, quality: qty, dateAdded: now, mediaInfo: { container: "mkv", durationSec: 3600 } })
    .returning()
    .get().id;
  db.update(schema.movies).set({ movieFileId: fileId }).where(eq(schema.movies.id, movieId)).run();
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeProgress(userId: number, opts: { watched?: boolean; ageMs?: number } = {}) {
  const db = getDb();
  db.delete(schema.watchProgress).run();
  db.insert(schema.watchProgress)
    .values({
      userId,
      movieId,
      positionSeconds: 900,
      durationSeconds: 3600,
      watched: opts.watched ?? false,
      updatedAt: new Date(Date.now() - (opts.ageMs ?? 0)),
    })
    .run();
}

describe("isUserStreaming (the watch.streamsChanged transition signal)", () => {
  it("is false with no progress at all", () => {
    getDb().delete(schema.watchProgress).run();
    expect(svc.isUserStreaming(sharerId)).toBe(false);
  });

  it("turns true on a fresh unfinished heartbeat", () => {
    writeProgress(sharerId);
    expect(svc.isUserStreaming(sharerId)).toBe(true);
  });

  it("expires once the heartbeat window lapses", () => {
    writeProgress(sharerId, { ageMs: svc.STREAM_WINDOW_MS + 1000 });
    expect(svc.isUserStreaming(sharerId)).toBe(false);
  });

  it("a finished title never counts as streaming", () => {
    writeProgress(sharerId, { watched: true });
    expect(svc.isUserStreaming(sharerId)).toBe(false);
  });
});

describe("shareable streams (the hosts list + badge source)", () => {
  it("lists only sharers inside the window", () => {
    writeProgress(sharerId);
    const streams = svc.getShareableStreams();
    expect(streams.map((s) => s.userId)).toEqual([sharerId]);

    // The same stream from a non-sharing user is invisible to watch-together.
    writeProgress(privateId);
    expect(svc.getShareableStreams()).toHaveLength(0);
  });

  it("userSharesStreaming reflects the per-user opt-in", () => {
    expect(svc.userSharesStreaming(sharerId)).toBe(true);
    expect(svc.userSharesStreaming(privateId)).toBe(false);
  });
});
