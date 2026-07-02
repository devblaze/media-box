import { describe, expect, it } from "vitest";
import { parseQuality, parseReleaseGroup, parseTitle } from "./release-parser";

interface TvCase {
  name: string;
  title: string;
  seasons: number[];
  episodes: number[];
  qualityId: number;
  group?: string;
  proper?: boolean;
}

const TV_CASES: TvCase[] = [
  // --- standard single episodes ---
  { name: "The.Series.S01E01.1080p.WEB-DL.DD5.1.H.264-GROUP", title: "the series", seasons: [1], episodes: [1], qualityId: 3, group: "GROUP" },
  { name: "The.Series.S01E01.720p.HDTV.x264-KILLERS", title: "the series", seasons: [1], episodes: [1], qualityId: 4, group: "KILLERS" },
  { name: "Series.Title.S02E13.1080p.BluRay.x264-ROVERS", title: "series title", seasons: [2], episodes: [13], qualityId: 7, group: "ROVERS" },
  { name: "Some.Show.2019.S03E05.2160p.WEB-DL.DDP5.1.HEVC-FLUX", title: "some show", seasons: [3], episodes: [5], qualityId: 18, group: "FLUX" },
  { name: "Another Show - S04E08 - Episode Title [HDTV-720p]", title: "another show", seasons: [4], episodes: [8], qualityId: 4 },
  { name: "show.name.105.hdtv-lol", title: "show name 105", seasons: [], episodes: [], qualityId: 4 }, // bare 105 numbering unsupported by design
  { name: "The.Show.S05E09.REPACK.720p.HDTV.x264-DIMENSION", title: "the show", seasons: [5], episodes: [9], qualityId: 4, group: "DIMENSION", proper: true },
  { name: "Show.S01E01.PROPER.1080p.WEB.h264-KOGi", title: "show", seasons: [1], episodes: [1], qualityId: 3, group: "KOGi", proper: true },
  // --- alternative numbering ---
  { name: "Show.Name.1x01.720p.WEB-DL.x264", title: "show name", seasons: [1], episodes: [1], qualityId: 5 },
  { name: "Show Name 4x13 WEBRip 1080p", title: "show name", seasons: [4], episodes: [13], qualityId: 15 },
  // --- multi-episode ---
  { name: "The.Show.S01E01E02.1080p.WEB-DL-GROUP", title: "the show", seasons: [1], episodes: [1, 2], qualityId: 3, group: "GROUP" },
  { name: "The.Show.S01E01-E03.720p.HDTV.x264", title: "the show", seasons: [1], episodes: [1, 2, 3], qualityId: 4 },
  // --- season packs ---
  { name: "The.Series.S01.1080p.BluRay.x264-SHORTBREHD", title: "the series", seasons: [1], episodes: [], qualityId: 7, group: "SHORTBREHD" },
  { name: "Series.Title.Season.2.1080p.WEB-DL.AAC2.0", title: "series title", seasons: [2], episodes: [], qualityId: 3 },
  { name: "The.Show.S01-S03.1080p.BluRay.x265-PACK", title: "the show", seasons: [1, 2, 3], episodes: [], qualityId: 7, group: "PACK" },
  // --- year in title ---
  { name: "Show.2016.S01E01.1080p.WEB-DL", title: "show", seasons: [1], episodes: [1], qualityId: 3 },
];

describe("parseTitle — TV", () => {
  for (const c of TV_CASES) {
    it(c.name, () => {
      const parsed = parseTitle(c.name);
      if (c.seasons.length > 0) {
        expect(parsed.isTv).toBe(true);
        expect(parsed.normalizedTitle).toBe(c.title);
        expect(parsed.seasons).toEqual(c.seasons);
        expect(parsed.episodes).toEqual(c.episodes);
      }
      expect(parsed.quality.qualityId).toBe(c.qualityId);
      if (c.group) expect(parsed.releaseGroup).toBe(c.group);
      if (c.proper) expect(parsed.quality.revision.version).toBe(2);
    });
  }

  it("detects full-season packs", () => {
    expect(parseTitle("The.Series.S01.1080p.BluRay.x264-X").isFullSeason).toBe(true);
    expect(parseTitle("The.Series.S01E01.1080p.WEB-DL").isFullSeason).toBe(false);
    expect(parseTitle("The.Show.S01-S03.720p-X").isMultiSeason).toBe(true);
  });
});

interface MovieCase {
  name: string;
  title: string;
  year?: number;
  qualityId: number;
  group?: string;
}

const MOVIE_CASES: MovieCase[] = [
  { name: "A.Movie.2023.1080p.BluRay.x264-SPARKS", title: "a movie", year: 2023, qualityId: 7, group: "SPARKS" },
  { name: "Movie.Title.2019.2160p.UHD.BluRay.x265-TERMiNAL", title: "movie title", year: 2019, qualityId: 19, group: "TERMiNAL" },
  { name: "Some Movie (2021) [1080p] [WEBRip]", title: "some movie", year: 2021, qualityId: 15 },
  { name: "The.Film.1994.REMASTERED.1080p.BluRay.H264.AAC-RARBG", title: "the film", year: 1994, qualityId: 7, group: "RARBG" },
  { name: "Movie.2020.720p.WEB-DL.DD5.1.H264-FGT", title: "movie", year: 2020, qualityId: 5, group: "FGT" },
  { name: "Old.Classic.1968.DVDRip.XviD-GROUP", title: "old classic", year: 1968, qualityId: 2, group: "GROUP" },
  { name: "Fresh.Movie.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX", title: "fresh movie", year: 2024, qualityId: 18, group: "FLUX" },
];

describe("parseTitle — movies", () => {
  for (const c of MOVIE_CASES) {
    it(c.name, () => {
      const parsed = parseTitle(c.name);
      expect(parsed.isTv).toBe(false);
      expect(parsed.normalizedTitle).toBe(c.title);
      expect(parsed.year).toBe(c.year);
      expect(parsed.quality.qualityId).toBe(c.qualityId);
      if (c.group) expect(parsed.releaseGroup).toBe(c.group);
    });
  }
});

describe("parseQuality", () => {
  it.each([
    ["Show.S01E01.2160p.WEB-DL", 18],
    ["Show.S01E01.4K.WEBRip", 17],
    ["Movie.1080p.BluRay.REMUX", 7],
    ["Show.720p.HDTV", 4],
    ["Show.HDTV.x264", 4], // hdtv without resolution -> 720p default
    ["Show.1080i.HDTV", 9],
    ["Movie.DVDRip", 2],
    ["Totally Unknown Release", 0],
  ])("%s -> quality %i", (name, expected) => {
    expect(parseQuality(name).qualityId).toBe(expected);
  });

  it("handles filenames with extensions", () => {
    const parsed = parseTitle("The.Show.S01E02.1080p.WEB-DL.x264-GRP.mkv");
    expect(parsed.episodes).toEqual([2]);
    expect(parsed.releaseGroup).toBe("GRP");
  });
});

describe("parseReleaseGroup", () => {
  it.each([
    ["Show.S01E01.720p.HDTV.x264-DIMENSION", "DIMENSION"],
    ["Movie.2023.1080p.WEB-DL.H264-FGT.mkv", "FGT"],
    ["Show.S01E01.1080p.WEB-DL", undefined],
    // quality token after dash must not count as group
    ["Show.S01E01.HDTV-1080p", undefined],
  ])("%s -> %s", (name, expected) => {
    expect(parseReleaseGroup(name)).toBe(expected);
  });
});
