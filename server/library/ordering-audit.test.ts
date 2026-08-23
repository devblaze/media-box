/**
 * Spotting a library whose files are numbered by a different season ordering
 * than the metadata — the state every Sonarr / Jellyfin / Plex transfer lands in
 * for long-running anime.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-audit-"));
process.env.CONFIG_DIR = TMP;

vi.mock("@/server/metadata/tmdb", () => ({}));

let schema: typeof import("@/server/db").schema;
let getDb: typeof import("@/server/db").getDb;
let audit: typeof import("@/server/library/ordering-audit");
let eq: typeof import("drizzle-orm").eq;

let bleachId: number;
let healthyId: number;

/** Add an episode plus a file whose *name* may disagree with it. */
function addEpisode(
  seriesId: number,
  season: number,
  episode: number,
  absoluteNumber: number | null,
  relativePath?: string
) {
  const db = getDb();
  const file = relativePath
    ? db
        .insert(schema.episodeFiles)
        .values({
          seriesId,
          relativePath,
          size: 1,
          quality: { qualityId: 1, revision: { version: 1, real: 0 } },
          dateAdded: new Date(),
        })
        .returning()
        .get()
    : null;
  db.insert(schema.episodes)
    .values({
      seriesId,
      seasonNumber: season,
      episodeNumber: episode,
      absoluteNumber,
      episodeFileId: file?.id ?? null,
    })
    .run();
}

function addSeries(title: string, isAnime: boolean): number {
  const db = getDb();
  const profile = db.select().from(schema.qualityProfiles).get()!;
  return db
    .insert(schema.series)
    .values({
      tmdbId: Math.floor(Math.random() * 1e6) + title.length,
      title,
      sortTitle: title.toLowerCase(),
      path: path.join(TMP, title),
      qualityProfileId: profile.id,
      isAnime,
      addedAt: new Date(),
    })
    .returning()
    .get().id;
}

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  audit = await import("@/server/library/ordering-audit");
  ({ eq } = await import("drizzle-orm"));

  const db = getDb();
  db.insert(schema.qualityProfiles)
    .values({ name: "Any", cutoffQualityId: 1, items: [{ qualityId: 1 }] })
    .run();

  // Bleach as a Sonarr transfer leaves it: TMDB's two seasons, but the files on
  // disk are numbered by TVDB's arcs and matched to whatever shared their number.
  bleachId = addSeries("Bleach", true);
  addEpisode(bleachId, 1, 1, 1, "Season 1/Bleach - S01E01 - The Day I Became a Shinigami.mkv");
  addEpisode(bleachId, 2, 21, 387, "Season 2/Bleach - S02E21 - Reunion, Ichigo and Rukia.mkv");
  addEpisode(bleachId, 1, 151, 151, "Season 7/Bleach - S07E20 - The Raging Storm.mkv");
  addEpisode(bleachId, 2, 38, 404, "Season 17/Bleach - S17E38 - FRIEND WEBDL-1080p.mkv");
  addEpisode(bleachId, 2, 39, 405); // missing on disk

  // A normal show whose files agree with its metadata.
  healthyId = addSeries("Breaking Bad", false);
  addEpisode(healthyId, 1, 1, 1, "Season 01/Breaking Bad - S01E01 - Pilot.mkv");
  addEpisode(healthyId, 2, 3, 10, "Season 02/Breaking Bad - S02E03 - Bit by a Dead Bee.mkv");
}, 60_000);

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("coordinateOfPath", () => {
  test("reads SxxExx out of the file name", () => {
    expect(audit.coordinateOfPath("Season 17/Bleach - S17E38 - FRIEND.mkv")).toEqual({
      seasonNumber: 17,
      episodeNumbers: [38],
      isAbsolute: false,
    });
  });

  test("falls back to the season folder when the name has only a number", () => {
    const c = audit.coordinateOfPath("Season 03/Bleach - 42 (1080p).mkv");
    expect(c.seasonNumber).toBe(3);
    expect(c.episodeNumbers).toEqual([42]);
    expect(c.isAbsolute).toBe(true);
  });

  test("a flat absolute file has no season at all", () => {
    const c = audit.coordinateOfPath("[SubsPlease] Bleach - 409 (1080p).mkv");
    expect(c.seasonNumber).toBeNull();
    expect(c.isAbsolute).toBe(true);
  });

  test("something that isn't an episode yields nothing", () => {
    expect(audit.coordinateOfPath("Bleach The Movie (2006) 1080p.mkv").episodeNumbers).toEqual([]);
  });
});

describe("auditLibraryOrdering", () => {
  test("flags the series whose files are numbered by another ordering", () => {
    const findings = audit.auditLibraryOrdering();
    const bleach = findings.find((f) => f.seriesId === bleachId);
    expect(bleach).toBeDefined();
    // S07E20 and S17E38 sit on episodes numbered S01E151 / S02E38.
    expect(bleach!.mismatched).toBe(2);
    expect(bleach!.filesChecked).toBe(4);
    expect(bleach!.unknownSeasons).toEqual([7, 17]);
    expect(bleach!.reason).toMatch(/seasons 7, 17/);
    expect(bleach!.isAnime).toBe(true);
  });

  test("leaves a healthy series alone", () => {
    expect(audit.auditLibraryOrdering().some((f) => f.seriesId === healthyId)).toBe(false);
  });

  test("can be scoped to specific series", () => {
    expect(audit.auditLibraryOrdering([healthyId])).toEqual([]);
    expect(audit.auditLibraryOrdering([bleachId])).toHaveLength(1);
  });

  test("a series with no files has nothing to say", () => {
    const emptyId = addSeries("Nothing Downloaded", true);
    addEpisode(emptyId, 1, 1, 1);
    expect(audit.auditLibraryOrdering([emptyId])).toEqual([]);
  });

  test("an absolute-numbered file is judged against the absolute number, not the season", () => {
    const id = addSeries("Absolute Anime", true);
    addEpisode(id, 3, 5, 55, "Season 03/Absolute Anime - 55 (1080p).mkv"); // agrees
    addEpisode(id, 3, 6, 56, "[Group] Absolute Anime - 999 (1080p).mkv"); // disagrees
    const finding = audit.auditLibraryOrdering([id])[0];
    expect(finding.mismatched).toBe(1);
  });
});

describe("the fixed state", () => {
  test("re-pointing the files at the right episodes clears the finding", () => {
    const db = getDb();
    // What a renumber onto TVDB order produces: S07E20 and S17E38 as themselves.
    for (const [season, episode, file] of [
      [7, 20, "Season 7/Bleach - S07E20 - The Raging Storm.mkv"],
      [17, 38, "Season 17/Bleach - S17E38 - FRIEND WEBDL-1080p.mkv"],
    ] as const) {
      const row = db
        .select()
        .from(schema.episodeFiles)
        .where(eq(schema.episodeFiles.relativePath, file))
        .get()!;
      const ep = db
        .select()
        .from(schema.episodes)
        .where(eq(schema.episodes.episodeFileId, row.id))
        .get()!;
      db.update(schema.episodes)
        .set({ seasonNumber: season, episodeNumber: episode })
        .where(eq(schema.episodes.id, ep.id))
        .run();
    }
    expect(audit.auditLibraryOrdering([bleachId])).toEqual([]);
  });
});
