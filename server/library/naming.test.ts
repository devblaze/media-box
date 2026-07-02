import { describe, expect, it } from "vitest";
import { renderEpisodeFilename, renderMovieFilename, renderSeasonFolder, renderSeriesFolder } from "./naming";
import { sanitizePathComponent } from "./naming-utils";

const DEFAULT_EP = "{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality}]";
const DEFAULT_MOVIE = "{Movie Title} ({Year}) [{Quality}]";

describe("naming", () => {
  it("renders a standard episode filename", () => {
    expect(
      renderEpisodeFilename(DEFAULT_EP, {
        seriesTitle: "Severance",
        seasonNumber: 1,
        episodeNumbers: [2],
        episodeTitle: "Half Loop",
        quality: { qualityId: 3, revision: { version: 1, real: 0 } },
      })
    ).toBe("Severance - S01E02 - Half Loop [WEB-DL-1080p]");
  });

  it("renders multi-episode files", () => {
    expect(
      renderEpisodeFilename(DEFAULT_EP, {
        seriesTitle: "Show",
        seasonNumber: 1,
        episodeNumbers: [1, 2],
        episodeTitle: "Pilot",
        quality: { qualityId: 4, revision: { version: 1, real: 0 } },
      })
    ).toBe("Show - S01E01-E02 - Pilot [HDTV-720p]");
  });

  it("marks propers", () => {
    expect(
      renderMovieFilename(DEFAULT_MOVIE, {
        movieTitle: "A Movie",
        movieYear: 2023,
        quality: { qualityId: 7, revision: { version: 2, real: 0 } },
      })
    ).toBe("A Movie (2023) [Bluray-1080p Proper]");
  });

  it("drops empty groups and illegal characters", () => {
    expect(
      renderMovieFilename("{Movie Title} ({Year}) [{Quality}]", {
        movieTitle: "What If...?: The Movie",
        movieYear: null,
        quality: { qualityId: 0, revision: { version: 1, real: 0 } },
      })
    ).toBe("What If...? The Movie [Unknown]".replace(/[?]/g, "")); // illegal chars stripped
  });

  it("renders folders", () => {
    expect(renderSeriesFolder("{Series Title} ({Year})", { title: "Dark", year: 2017 })).toBe(
      "Dark (2017)"
    );
    expect(renderSeasonFolder("Season {season:00}", 3)).toBe("Season 03");
  });

  it("sanitize keeps spaces and dashes", () => {
    expect(sanitizePathComponent("Breaking Bad - Season 1 (2008)")).toBe(
      "Breaking Bad - Season 1 (2008)"
    );
    expect(sanitizePathComponent('Bad<>:"/\\|?*Name')).toBe("BadName");
  });
});
