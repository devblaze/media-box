import { describe, expect, test } from "vitest";
import { parseTitle } from "./release-parser";
import { evaluate, type ProfileLike } from "./scoring";

/**
 * Anime fansub releases ([SubsPlease], [ToonsHub], …) number episodes
 * ABSOLUTELY — "Title - 05" — with no SxxExx. Before this was supported the
 * parser read them as movies, so every such release was rejected with
 * "Not a recognizable TV release" and "Title '… - 05 (' does not match".
 */

const profile: ProfileLike = {
  cutoffQualityId: 7,
  upgradeAllowed: true,
  // Allow everything so quality never masks the numbering assertions.
  items: Array.from({ length: 40 }, (_, i) => ({ qualityId: i, allowed: true })),
};

describe("absolute numbering — parsing", () => {
  test("SubsPlease episode parses as TV with the absolute episode number", () => {
    const p = parseTitle("[SubsPlease] Gachiakuta - 05 (1080p) [1B6961B4].mkv");
    expect(p.isTv).toBe(true);
    expect(p.isAbsolute).toBe(true);
    expect(p.episodes).toEqual([5]);
    expect(p.seasons).toEqual([]);
    expect(p.releaseGroup).toBe("SubsPlease");
  });

  test("the title is clean — it matches the same show parsed from an SxxExx release", () => {
    const abs = parseTitle("[SubsPlease] Gachiakuta - 05 (1080p) [1B6961B4].mkv");
    const std = parseTitle("Gachiakuta S01E05 1080p WEB-DL");
    expect(abs.normalizedTitle).toBe(std.normalizedTitle);
  });

  test("batch releases expand to the whole range", () => {
    const p = parseTitle("[SubsPlease] Gachiakuta - 01-24 (1080p)");
    expect(p.isAbsolute).toBe(true);
    expect(p.episodes).toHaveLength(24);
    expect(p.episodes[0]).toBe(1);
    expect(p.episodes[23]).toBe(24);
  });

  test("a version suffix (12v2) is ignored", () => {
    expect(parseTitle("[ToonsHub] Show Name - 12v2 (720p)").episodes).toEqual([12]);
  });

  test("an explicit SxxExx always wins over the absolute pattern", () => {
    const p = parseTitle("Show - 05 S02E03 1080p");
    expect(p.seasons).toEqual([2]);
    expect(p.episodes).toEqual([3]);
    expect(p.isAbsolute).toBeUndefined();
  });

  test("a year after a dash is not an episode number (stays a movie)", () => {
    const p = parseTitle("Some Film - 2024 (1080p)");
    expect(p.isTv).toBe(false);
    expect(p.episodes).toEqual([]);
  });

  test("a hyphenated title without a number is unaffected", () => {
    const p = parseTitle("Spider-Man Far From Home (2019) 1080p BluRay");
    expect(p.isTv).toBe(false);
    expect(p.normalizedTitle).toContain("spider");
  });
});

describe("absolute numbering — scoring", () => {
  const release = {
    guid: "g1",
    indexerId: 1,
    indexerName: "SubsPlease",
    title: "[SubsPlease] Gachiakuta - 05 (1080p) [1B6961B4].mkv",
    size: 1_400_000_000,
    seeders: 40,
    leechers: 2,
    downloadUrl: "magnet:?xt=urn:btih:abc",
    parsed: parseTitle("[SubsPlease] Gachiakuta - 05 (1080p) [1B6961B4].mkv"),
  };

  test("the wanted absolute episode is accepted", () => {
    const res = evaluate(release, {
      mediaType: "series",
      profile,
      targetTitles: ["Gachiakuta"],
      seasonNumber: 1,
      episodeNumbers: [5],
    });
    expect(res.rejections).toEqual([]);
    expect(res.accepted).toBe(true);
  });

  test("a different episode is rejected as the wrong episode", () => {
    const res = evaluate(release, {
      mediaType: "series",
      profile,
      targetTitles: ["Gachiakuta"],
      seasonNumber: 1,
      episodeNumbers: [7],
    });
    expect(res.accepted).toBe(false);
    expect(res.rejections.join(" ")).toMatch(/wrong episode/i);
  });

  test("no 'wrong season' rejection — an absolute release names no season", () => {
    const res = evaluate(release, {
      mediaType: "series",
      profile,
      targetTitles: ["Gachiakuta"],
      seasonNumber: 2,
      episodeNumbers: [5],
    });
    expect(res.rejections.join(" ")).not.toMatch(/wrong season/i);
  });

  test("a non-matching show title is still rejected", () => {
    const res = evaluate(release, {
      mediaType: "series",
      profile,
      targetTitles: ["Some Other Anime"],
      seasonNumber: 1,
      episodeNumbers: [5],
    });
    expect(res.accepted).toBe(false);
    expect(res.rejections.join(" ")).toMatch(/does not match/i);
  });
});

/**
 * A show whose seasons are numbered TVDB-style (Bleach S17E42) but whose releases
 * are numbered across the whole run (episode 408). The absolute number is what
 * decides the match — the in-season number would say 42 and grab the wrong file.
 */
describe("absolute numbering — long-running anime", () => {
  const bleach408 = {
    guid: "g2",
    indexerId: 1,
    indexerName: "Nyaa",
    title: "[SubsPlease] Bleach - 408 (1080p) [ABCD1234].mkv",
    size: 1_400_000_000,
    seeders: 40,
    leechers: 2,
    downloadUrl: "magnet:?xt=urn:btih:def",
    parsed: parseTitle("[SubsPlease] Bleach - 408 (1080p) [ABCD1234].mkv"),
  };
  const ctx = {
    mediaType: "series" as const,
    profile,
    targetTitles: ["Bleach"],
    seasonNumber: 17,
    episodeNumbers: [42],
  };

  test("the wanted absolute number is accepted for a high season", () => {
    const res = evaluate(bleach408, { ...ctx, absoluteEpisodeNumbers: [408] });
    expect(res.rejections).toEqual([]);
    expect(res.accepted).toBe(true);
  });

  test("a release numbered like the in-season episode is rejected", () => {
    const res = evaluate(
      { ...bleach408, title: "[SubsPlease] Bleach - 42 (1080p).mkv", parsed: parseTitle("[SubsPlease] Bleach - 42 (1080p).mkv") },
      { ...ctx, absoluteEpisodeNumbers: [408] }
    );
    expect(res.accepted).toBe(false);
    expect(res.rejections.join(" ")).toMatch(/wrong episode/i);
  });

  test("a whole-run batch is not grabbed for a single-episode search", () => {
    const batch = parseTitle("[Erai-raws] Bleach - 01-366 (1080p)");
    const res = evaluate(
      { ...bleach408, title: batch.originalTitle, parsed: batch },
      { ...ctx, absoluteEpisodeNumbers: [408], episodeNumbers: [42], allowSeasonPack: false }
    );
    expect(res.accepted).toBe(false);
  });

  test("without absolute numbers it still falls back to the in-season number", () => {
    const res = evaluate(
      { ...bleach408, title: "[SubsPlease] Bleach - 42 (1080p).mkv", parsed: parseTitle("[SubsPlease] Bleach - 42 (1080p).mkv") },
      ctx
    );
    expect(res.accepted).toBe(true);
  });
});
