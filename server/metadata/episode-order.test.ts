/**
 * Alternate season orderings (TMDB episode groups).
 *
 * TMDB airs Bleach as two seasons — S01E001–E366 plus a 50-episode
 * "Thousand-Year Blood War" — while Jellyfin, the folders on disk and release
 * groups all follow TVDB's 17 arc-seasons. These tests pin the translation
 * between the two, and the absolute numbers that survive it.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const getTvEpisodeGroup = vi.fn();
const getTvSeason = vi.fn();
const getTvEpisodeGroups = vi.fn();

vi.mock("@/server/metadata/tmdb", () => ({
  getTvEpisodeGroup: (...args: unknown[]) => getTvEpisodeGroup(...args),
  getTvEpisodeGroups: (...args: unknown[]) => getTvEpisodeGroups(...args),
  getTvSeason: (...args: unknown[]) => getTvSeason(...args),
}));

const {
  absoluteNumberer,
  bestOrdering,
  buildAiredOrder,
  buildEpisodeOrder,
  buildGroupOrder,
  pickTvdbOrderGroup,
  scoreOrderings,
} = await import("./episode-order");

/** A group season: `order` is its season number, episodes carry native coords. */
function group(
  order: number,
  name: string,
  native: [season: number, from: number, to: number]
) {
  const [seasonNumber, from, to] = native;
  const episodes = [];
  for (let n = from; n <= to; n++) {
    episodes.push({
      id: seasonNumber * 10_000 + n,
      season_number: seasonNumber,
      episode_number: n,
      order: n - from,
      name: `Episode ${n}`,
      air_date: "2004-10-05",
      runtime: 24,
    });
  }
  return { id: `g${order}`, name, order, episodes };
}

// Bleach, trimmed: three arcs out of season 1 plus TYBW, and the specials.
const BLEACH_TVDB_GROUP = {
  id: "tvdb",
  name: "TVDB Order",
  type: 1 as const,
  groups: [
    group(1, "Substitute Shinigami", [1, 1, 20]),
    group(2, "The Entry", [1, 21, 41]),
    group(3, "The Rescue", [1, 42, 63]),
    group(17, "Thousand-Year Blood War", [2, 1, 50]),
    group(0, "Specials", [0, 1, 4]),
  ],
};

const BLEACH_SEASONS = [
  { season_number: 0, episode_count: 4 },
  { season_number: 1, episode_count: 366 },
  { season_number: 2, episode_count: 50 },
];

beforeEach(() => {
  getTvEpisodeGroup.mockReset();
  getTvSeason.mockReset();
  getTvEpisodeGroups.mockReset();
});

describe("absoluteNumberer", () => {
  test("counts through the aired seasons, skipping specials", () => {
    const abs = absoluteNumberer(new Map([[0, 4], [1, 366], [2, 50]]));
    expect(abs(1, 1)).toBe(1);
    expect(abs(1, 366)).toBe(366);
    expect(abs(2, 1)).toBe(367);
    expect(abs(2, 42)).toBe(408);
    expect(abs(0, 3)).toBeNull();
  });
});

describe("buildGroupOrder", () => {
  test("re-numbers the show into the group's seasons", async () => {
    getTvEpisodeGroup.mockResolvedValue(BLEACH_TVDB_GROUP);
    const eps = await buildGroupOrder("tvdb", BLEACH_SEASONS);

    // Native S01E042 (start of the Rescue arc) becomes S03E01.
    const rescueOpener = eps.find((e) => e.tmdbEpisodeId === 10_042)!;
    expect(rescueOpener.seasonNumber).toBe(3);
    expect(rescueOpener.episodeNumber).toBe(1);

    // TYBW is season 17, numbered from 1 within it.
    const tybw = eps.filter((e) => e.seasonNumber === 17);
    expect(tybw).toHaveLength(50);
    expect(tybw[0].episodeNumber).toBe(1);
    expect(tybw[49].episodeNumber).toBe(50);

    expect(eps.filter((e) => e.seasonNumber === 0)).toHaveLength(4);
  });

  test("absolute numbers stay on the aired scale across the renumber", async () => {
    getTvEpisodeGroup.mockResolvedValue(BLEACH_TVDB_GROUP);
    const eps = await buildGroupOrder("tvdb", BLEACH_SEASONS);

    const s03e01 = eps.find((e) => e.seasonNumber === 3 && e.episodeNumber === 1)!;
    expect(s03e01.absoluteNumber).toBe(42);

    // The episode the UI shows as S17E42 is release-numbered 408.
    const s17e42 = eps.find((e) => e.seasonNumber === 17 && e.episodeNumber === 42)!;
    expect(s17e42.absoluteNumber).toBe(408);

    expect(eps.filter((e) => e.seasonNumber === 0).every((e) => e.absoluteNumber === null)).toBe(
      true
    );
  });

  test("a 0-based group without specials is shifted up, not read as specials", async () => {
    getTvEpisodeGroup.mockResolvedValue({
      id: "dvd",
      name: "DVD Order",
      type: 3,
      groups: [group(0, "Season 1", [1, 1, 12]), group(1, "Season 2", [1, 13, 24])],
    });
    const eps = await buildGroupOrder("dvd", [{ season_number: 1, episode_count: 24 }]);
    expect(new Set(eps.map((e) => e.seasonNumber))).toEqual(new Set([1, 2]));
  });

  test("season lengths fall back to the group when a summary lags behind", async () => {
    getTvEpisodeGroup.mockResolvedValue(BLEACH_TVDB_GROUP);
    // TMDB summary still says season 1 has 300 episodes; the group knows 366-ish.
    const eps = await buildGroupOrder("tvdb", [
      { season_number: 1, episode_count: 63 },
      { season_number: 2, episode_count: 0 },
    ]);
    const tybwFirst = eps.find((e) => e.seasonNumber === 17 && e.episodeNumber === 1)!;
    expect(tybwFirst.absoluteNumber).toBe(64);
  });
});

describe("buildAiredOrder", () => {
  test("keeps TMDB's own numbering and numbers absolutely across seasons", async () => {
    getTvSeason.mockImplementation(async (_id: number, season: number) => ({
      season_number: season,
      episodes:
        season === 0
          ? [{ id: 900, season_number: 0, episode_number: 1, name: "OVA" }]
          : Array.from({ length: season === 1 ? 3 : 2 }, (_, i) => ({
              id: season * 100 + i + 1,
              season_number: season,
              episode_number: i + 1,
              name: `S${season}E${i + 1}`,
            })),
    }));
    const eps = await buildAiredOrder(7, [
      { season_number: 0 },
      { season_number: 1 },
      { season_number: 2 },
    ]);
    expect(eps.filter((e) => e.seasonNumber > 0).map((e) => e.absoluteNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(eps.find((e) => e.seasonNumber === 0)!.absoluteNumber).toBeNull();
  });
});

describe("buildEpisodeOrder", () => {
  test("falls back to the aired order when the group is broken", async () => {
    getTvEpisodeGroup.mockRejectedValue(new Error("TMDB /tv/episode_group/x responded 404"));
    getTvSeason.mockResolvedValue({
      season_number: 1,
      episodes: [{ id: 1, season_number: 1, episode_number: 1, name: "Pilot" }],
    });
    const eps = await buildEpisodeOrder(7, [{ season_number: 1 }], "gone");
    expect(eps).toHaveLength(1);
    expect(eps[0].seasonNumber).toBe(1);
  });
});

describe("pickTvdbOrderGroup", () => {
  const g = (name: string, type: number, groupCount = 18, episodeCount = 420) => ({
    id: name,
    name,
    type: type as 1,
    group_count: groupCount,
    episode_count: episodeCount,
  });

  test("prefers the aired-date TVDB grouping", () => {
    expect(
      pickTvdbOrderGroup([g("Arcs", 5), g("TVDB Order", 1), g("Crunchyroll Season Split", 4)])?.id
    ).toBe("TVDB Order");
  });

  test("ignores shows with no TVDB grouping", () => {
    expect(pickTvdbOrderGroup([g("Arcs", 5), g("Netflix", 4)])).toBeNull();
  });

  test("ignores a single-season 'TVDB' grouping — it renumbers nothing", () => {
    expect(pickTvdbOrderGroup([g("TVDB Order", 1, 1, 12)])).toBeNull();
  });
});


/**
 * Choosing an ordering from the numbering a library already uses — the thing
 * that makes a Sonarr/Jellyfin/Plex library line up without asking the user.
 */
describe("scoreOrderings / bestOrdering", () => {
  const TVDB_SUMMARY = {
    id: "tvdb",
    name: "TVDB Order",
    type: 1 as const,
    group_count: 5,
    episode_count: 420,
  };

  test("a library numbered TVDB-style picks the TVDB grouping over aired order", async () => {
    getTvEpisodeGroups.mockResolvedValue({ results: [TVDB_SUMMARY] });
    getTvEpisodeGroup.mockResolvedValue(BLEACH_TVDB_GROUP);

    // What a Sonarr-sorted Bleach folder looks like: seasons 1-3 and 17.
    const observed = [
      { seasonNumber: 1, episodeNumber: 5 },
      { seasonNumber: 2, episodeNumber: 21 },
      { seasonNumber: 3, episodeNumber: 22 },
      { seasonNumber: 17, episodeNumber: 42 },
    ];
    const scores = await scoreOrderings(30984, BLEACH_SEASONS, observed);
    const aired = scores.find((s) => s.id === null)!;
    const tvdb = scores.find((s) => s.id === "tvdb")!;
    // Aired order only has seasons 1 and 2, and its season 2 stops at 50 — so it
    // explains S01E05 and S02E21 but neither S03E22 nor S17E42.
    expect(aired.covered).toBe(2);
    expect(tvdb.coverage).toBe(1);
    expect(bestOrdering(scores, null)?.id).toBe("tvdb");
  });

  test("a library that already matches aired order costs no group lookups", async () => {
    getTvEpisodeGroups.mockResolvedValue({ results: [TVDB_SUMMARY] });
    const observed = [
      { seasonNumber: 1, episodeNumber: 5 },
      { seasonNumber: 2, episodeNumber: 12 },
    ];
    const scores = await scoreOrderings(30984, BLEACH_SEASONS, observed);
    expect(scores.find((s) => s.id === null)!.coverage).toBe(1);
    expect(getTvEpisodeGroup).not.toHaveBeenCalled();
    expect(bestOrdering(scores, null)).toBeNull(); // nothing to change
  });

  test("thin or ambiguous evidence never triggers a renumber", async () => {
    getTvEpisodeGroups.mockResolvedValue({ results: [TVDB_SUMMARY] });
    getTvEpisodeGroup.mockResolvedValue(BLEACH_TVDB_GROUP);
    // One stray file naming a season nobody has: TVDB order explains it, but so
    // little of the library is at stake that renumbering would be a guess.
    const scores = await scoreOrderings(30984, BLEACH_SEASONS, [
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
      { seasonNumber: 1, episodeNumber: 3 },
      { seasonNumber: 9, episodeNumber: 4 },
    ]);
    expect(bestOrdering(scores, null)).toBeNull();
  });

  test("no evidence at all leaves the ordering alone", async () => {
    const scores = await scoreOrderings(30984, BLEACH_SEASONS, []);
    expect(bestOrdering(scores, null)).toBeNull();
    expect(getTvEpisodeGroups).not.toHaveBeenCalled();
  });

  test("the ordering already in use is never 'changed' to itself", async () => {
    getTvEpisodeGroups.mockResolvedValue({ results: [TVDB_SUMMARY] });
    getTvEpisodeGroup.mockResolvedValue(BLEACH_TVDB_GROUP);
    const scores = await scoreOrderings(30984, BLEACH_SEASONS, [
      { seasonNumber: 3, episodeNumber: 1 },
      { seasonNumber: 17, episodeNumber: 42 },
    ]);
    expect(bestOrdering(scores, "tvdb")).toBeNull();
  });
});
