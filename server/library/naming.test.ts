import { describe, expect, it } from "vitest";
import {
  DEFAULT_MULTI_EPISODE_STYLE,
  LEGACY_MULTI_EPISODE_STYLE,
  MULTI_EPISODE_STYLES,
  SONARR_DEFAULTS,
  renderEpisodeFilename,
  renderMovieFilename,
  renderSeasonFolder,
  renderSeriesFolder,
  type EpisodeNamingContext,
} from "./naming";
import { sanitizePathComponent } from "./naming-utils";
import { schema } from "@/server/db";

const DEFAULT_EP = SONARR_DEFAULTS.standardEpisodeFormat;
const ANIME_EP = SONARR_DEFAULTS.animeEpisodeFormat;
const DEFAULT_MOVIE = SONARR_DEFAULTS.movieFormat;
/** media-box's pre-Sonarr-compat formats, still in use on existing installs. */
const LEGACY_EP = "{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality}]";
const LEGACY_MOVIE = "{Movie Title} ({Year}) [{Quality}]";

const WEBDL_1080 = { qualityId: 3, revision: { version: 1, real: 0 } };
const HDTV_720 = { qualityId: 4, revision: { version: 1, real: 0 } };

function ep(over: Partial<EpisodeNamingContext> = {}): EpisodeNamingContext {
  return {
    seriesTitle: "Bleach",
    seasonNumber: 1,
    episodeNumbers: [1],
    episodeTitle: "The Day I Became a Shinigami",
    quality: WEBDL_1080,
    ...over,
  };
}

describe("naming", () => {
  it("renders a standard episode filename in Sonarr's spelling", () => {
    expect(
      renderEpisodeFilename(DEFAULT_EP, {
        seriesTitle: "Severance",
        seasonNumber: 1,
        episodeNumbers: [2],
        episodeTitle: "Half Loop",
        quality: WEBDL_1080,
      })
    ).toBe("Severance - S01E02 - Half Loop WEBDL-1080p");
  });

  it("keeps the legacy {Quality} spelling for installs that still use it", () => {
    expect(
      renderEpisodeFilename(LEGACY_EP, {
        seriesTitle: "Severance",
        seasonNumber: 1,
        episodeNumbers: [2],
        episodeTitle: "Half Loop",
        quality: WEBDL_1080,
      })
    ).toBe("Severance - S01E02 - Half Loop [WEB-DL-1080p]");
  });

  it("marks propers", () => {
    expect(
      renderMovieFilename(LEGACY_MOVIE, {
        movieTitle: "A Movie",
        movieYear: 2023,
        quality: { qualityId: 7, revision: { version: 2, real: 0 } },
      })
    ).toBe("A Movie (2023) [Bluray-1080p Proper]");
    expect(
      renderMovieFilename(DEFAULT_MOVIE, {
        movieTitle: "A Movie",
        movieYear: 2023,
        quality: { qualityId: 3, revision: { version: 2, real: 0 } },
      })
    ).toBe("A Movie (2023) WEBDL-1080p Proper");
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

  it("leaves unknown tokens verbatim", () => {
    expect(renderEpisodeFilename("{Series Title} {Nonsense} S{season:00}", ep())).toBe(
      "Bleach {Nonsense} S01"
    );
  });

  // ---------- multi-episode styles ----------

  describe("multi-episode styles", () => {
    it("a new install's configured default is Sonarr's extend", () => {
      expect(DEFAULT_MULTI_EPISODE_STYLE).toBe("extend");
      expect(SONARR_DEFAULTS.multiEpisodeStyle).toBe("extend");
      expect(
        renderEpisodeFilename(DEFAULT_EP, {
          seriesTitle: "Show",
          seasonNumber: 1,
          episodeNumbers: [1, 2],
          episodeTitle: "Pilot",
          quality: HDTV_720,
          multiEpisodeStyle: "extend",
        })
      ).toBe("Show - S01E01-02 - Pilot HDTV-720p");
    });

    it("renders the legacy scene style installs already have", () => {
      expect(LEGACY_MULTI_EPISODE_STYLE).toBe("scene");
      expect(
        renderEpisodeFilename(LEGACY_EP, {
          seriesTitle: "Show",
          seasonNumber: 1,
          episodeNumbers: [1, 2],
          episodeTitle: "Pilot",
          quality: HDTV_720,
          multiEpisodeStyle: "scene",
        })
      ).toBe("Show - S01E01-E02 - Pilot [HDTV-720p]");
    });

    it("a caller that passes no style keeps media-box's historical output", () => {
      // Guards the window before the importer is wired to naming_config: an
      // un-wired caller must not switch an existing library to a second scheme.
      expect(
        renderEpisodeFilename(LEGACY_EP, {
          seriesTitle: "Show",
          seasonNumber: 1,
          episodeNumbers: [1, 2],
          episodeTitle: "Pilot",
          quality: HDTV_720,
        })
      ).toBe("Show - S01E01-E02 - Pilot [HDTV-720p]");
    });

    const two: Record<string, string> = {
      extend: "S01E01-02",
      scene: "S01E01-E02",
      repeat: "S01E01E02",
      range: "S01E01-02",
      prefixedRange: "S01E01-E02",
    };
    const three: Record<string, string> = {
      extend: "S01E01-02-03",
      scene: "S01E01-E02-E03",
      repeat: "S01E01E02E03",
      range: "S01E01-03",
      prefixedRange: "S01E01-E03",
    };

    for (const style of MULTI_EPISODE_STYLES) {
      it(`renders two and three episodes in ${style} style`, () => {
        expect(
          renderEpisodeFilename("S{season:00}E{episode:00}", ep({ episodeNumbers: [1, 2], multiEpisodeStyle: style }))
        ).toBe(two[style]);
        // three or more: middle episodes are kept, never dropped (except the
        // two styles that are ranges by definition)
        expect(
          renderEpisodeFilename(
            "S{season:00}E{episode:00}",
            ep({ episodeNumbers: [1, 2, 3], multiEpisodeStyle: style })
          )
        ).toBe(three[style]);
      });
    }

    it("applies the style to the bare {episode} tokens too", () => {
      expect(
        renderEpisodeFilename(
          "{season:00}x{episode:00}",
          ep({ episodeNumbers: [5, 6, 7], multiEpisodeStyle: "extend" })
        )
      ).toBe("01x05-06-07");
      expect(
        renderEpisodeFilename("{episode}", ep({ episodeNumbers: [5, 6, 7], multiEpisodeStyle: "extend" }))
      ).toBe("5-6-7");
      // never drops the middle episodes, whatever the style
      expect(
        renderEpisodeFilename("{episode:00}", ep({ episodeNumbers: [5, 6, 7], multiEpisodeStyle: "scene" }))
      ).toBe("05-06-07");
    });

    it("falls back to the legacy style for an unknown value", () => {
      expect(
        renderEpisodeFilename(
          "S{season:00}E{episode:00}",
          // a hand-edited DB row could hold anything
          ep({ episodeNumbers: [1, 2], multiEpisodeStyle: "nonsense" as never })
        )
      ).toBe("S01E01-E02");
    });
  });

  // ---------- anime / absolute numbers ----------

  describe("anime episode format", () => {
    it("renders the absolute number", () => {
      expect(
        renderEpisodeFilename(ANIME_EP, ep({ seasonNumber: 17, episodeNumbers: [38], absoluteNumbers: [404] }))
      ).toBe("Bleach - S17E38 - 404 - The Day I Became a Shinigami WEBDL-1080p");
    });

    it("zero-pads the absolute number to three digits", () => {
      expect(
        renderEpisodeFilename(ANIME_EP, ep({ seasonNumber: 1, episodeNumbers: [1], absoluteNumbers: [1] }))
      ).toBe("Bleach - S01E01 - 001 - The Day I Became a Shinigami WEBDL-1080p");
    });

    it("collapses the separator when the absolute number is missing", () => {
      expect(renderEpisodeFilename(ANIME_EP, ep())).toBe(
        "Bleach - S01E01 - The Day I Became a Shinigami WEBDL-1080p"
      );
      expect(renderEpisodeFilename(ANIME_EP, ep({ absoluteNumbers: [null] }))).toBe(
        "Bleach - S01E01 - The Day I Became a Shinigami WEBDL-1080p"
      );
      expect(renderEpisodeFilename(ANIME_EP, ep({ absoluteNumbers: [] }))).toBe(
        "Bleach - S01E01 - The Day I Became a Shinigami WEBDL-1080p"
      );
    });

    it("renders multi-episode absolute numbers in the chosen style", () => {
      expect(
        renderEpisodeFilename(
          ANIME_EP,
          ep({
            episodeNumbers: [1, 2],
            absoluteNumbers: [1, 2],
            episodeTitle: "Two-parter",
            multiEpisodeStyle: "extend",
          })
        )
      ).toBe("Bleach - S01E01-02 - 001-002 - Two-parter WEBDL-1080p");
      expect(
        renderEpisodeFilename(
          ANIME_EP,
          ep({
            episodeNumbers: [1, 2],
            absoluteNumbers: [1, 2],
            episodeTitle: "Two-parter",
            multiEpisodeStyle: "scene",
          })
        )
      ).toBe("Bleach - S01E01-E02 - 001-002 - Two-parter WEBDL-1080p");
    });

    it("supports the shorter absolute tokens", () => {
      expect(renderEpisodeFilename("{absolute:00}", ep({ absoluteNumbers: [7] }))).toBe("07");
      expect(renderEpisodeFilename("{absolute}", ep({ absoluteNumbers: [7] }))).toBe("7");
      expect(renderEpisodeFilename("{absolute:000}", ep({ absoluteNumbers: [7] }))).toBe("007");
    });

    it("ignores nulls mixed into the absolute numbers", () => {
      expect(
        renderEpisodeFilename("{absolute:000}", ep({ episodeNumbers: [1, 2], absoluteNumbers: [null, 12] }))
      ).toBe("012");
    });
  });

  // ---------- quality tokens ----------

  describe("quality tokens", () => {
    it("renders {Quality Full} and {Quality Title} in Sonarr's spelling", () => {
      expect(renderEpisodeFilename("{Quality Title}", ep())).toBe("WEBDL-1080p");
      expect(renderEpisodeFilename("{Quality Full}", ep())).toBe("WEBDL-1080p");
      expect(
        renderEpisodeFilename("{Quality Full}", ep({ quality: { qualityId: 3, revision: { version: 2, real: 0 } } }))
      ).toBe("WEBDL-1080p Proper");
      expect(
        renderEpisodeFilename(
          "{Quality Title}",
          ep({ quality: { qualityId: 3, revision: { version: 2, real: 0 } } })
        )
      ).toBe("WEBDL-1080p");
    });

    it("leaves {Quality} on media-box's own spelling", () => {
      expect(renderEpisodeFilename("{Quality}", ep())).toBe("WEB-DL-1080p");
    });

    it("only the WEB-DL ladder differs; every other name is shared", () => {
      for (const id of [0, 1, 2, 8, 4, 14, 6, 9, 15, 7, 16, 17, 19]) {
        const q = { qualityId: id, revision: { version: 1, real: 0 } };
        expect(renderEpisodeFilename("{Quality Title}", ep({ quality: q }))).toBe(
          renderEpisodeFilename("{Quality}", ep({ quality: q }))
        );
      }
      for (const id of [12, 5, 3, 18]) {
        const q = { qualityId: id, revision: { version: 1, real: 0 } };
        expect(renderEpisodeFilename("{Quality Title}", ep({ quality: q }))).toBe(
          renderEpisodeFilename("{Quality}", ep({ quality: q })).replace("WEB-DL-", "WEBDL-")
        );
      }
    });

    it("renders the quality tokens for movies too", () => {
      const movie = { movieTitle: "A Movie", movieYear: 2023, quality: WEBDL_1080 };
      expect(renderMovieFilename("{Quality Full}", movie)).toBe("WEBDL-1080p");
      expect(renderMovieFilename("{Quality Title}", movie)).toBe("WEBDL-1080p");
      expect(renderMovieFilename("{Quality}", movie)).toBe("WEB-DL-1080p");
    });
  });

  // ---------- specials folder ----------

  describe("specials folder", () => {
    it("uses the specials format for season 0", () => {
      expect(
        renderSeasonFolder("Season {season:00}", 0, { specialsFormat: "Specials" })
      ).toBe("Specials");
    });

    it("leaves other seasons on the season format", () => {
      expect(renderSeasonFolder("Season {season:00}", 1, { specialsFormat: "Specials" })).toBe(
        "Season 01"
      );
      expect(renderSeasonFolder("Season {season:00}", 17, { specialsFormat: "Specials" })).toBe(
        "Season 17"
      );
    });

    it("still renders season 0 as Season 00 when no specials format is given", () => {
      expect(renderSeasonFolder("Season {season:00}", 0)).toBe("Season 00");
      expect(renderSeasonFolder("Season {season:00}", 0, { specialsFormat: "" })).toBe("Season 00");
      expect(renderSeasonFolder("Season {season:00}", 0, { specialsFormat: null })).toBe(
        "Season 00"
      );
    });

    it("renders tokens inside the specials format", () => {
      expect(
        renderSeasonFolder("Season {season:00}", 0, { specialsFormat: "Specials {season:00}" })
      ).toBe("Specials 00");
    });
  });

  // ---------- defaults ----------

  it("SONARR_DEFAULTS matches the naming_config column defaults", () => {
    const cols = schema.namingConfig as unknown as Record<string, { default: unknown }>;
    for (const [key, value] of Object.entries(SONARR_DEFAULTS)) {
      expect(cols[key].default, key).toBe(value);
    }
  });
});
