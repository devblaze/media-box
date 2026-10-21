import { describe, expect, test } from "vitest";
import { JellyfinIdIndex, parseNfoIds } from "./id-hints";

describe("parseNfoIds", () => {
  test("reads Jellyfin/Kodi uniqueid tags", () => {
    const xml = `<?xml version="1.0"?><movie>
      <title>Inception</title>
      <uniqueid type="imdb" default="true">tt1375666</uniqueid>
      <uniqueid type="tmdb">27205</uniqueid>
    </movie>`;
    expect(parseNfoIds(xml)).toEqual({ imdbId: "tt1375666", tmdbId: 27205 });
  });

  test("reads the older single tags, and Kodi's bare imdb <id>", () => {
    expect(parseNfoIds("<tvshow><tvdbid>81189</tvdbid><tmdbid>1396</tmdbid></tvshow>")).toEqual({
      tvdbId: 81189,
      tmdbId: 1396,
    });
    expect(parseNfoIds("<movie><id>tt0133093</id></movie>")).toEqual({ imdbId: "tt0133093" });
  });

  test("ignores empty and malformed ids", () => {
    expect(
      parseNfoIds('<movie><uniqueid type="tmdb">0</uniqueid><imdbid>none</imdbid></movie>')
    ).toEqual({});
  });
});

describe("JellyfinIdIndex", () => {
  const index = new JellyfinIdIndex([
    {
      Id: "1",
      Type: "Movie",
      Path: "/data/movies/Inception (2010)/Inception (2010).mkv",
      ProviderIds: { Tmdb: "27205" },
    },
    {
      Id: "2",
      Type: "Series",
      Path: "/data/tv/Breaking Bad",
      ProviderIds: { Tvdb: "81189", Tmdb: "1396" },
    },
    // Two films in one category folder: the folder name can't say which is which.
    {
      Id: "3",
      Type: "Movie",
      Path: "/data/movies/Classics/Metropolis.mkv",
      ProviderIds: { Tmdb: "19" },
    },
    {
      Id: "4",
      Type: "Movie",
      Path: "/data/movies/Classics/Nosferatu.mkv",
      ProviderIds: { Tmdb: "653" },
    },
    {
      Id: "5",
      Type: "Movie",
      Path: "D:\\Films\\Heat (1995)\\Heat.mkv",
      ProviderIds: { Imdb: "tt0113277" },
    },
  ]);

  test("matches by name, whatever the path prefix on either side", () => {
    expect(
      index.lookup({
        kind: "movie",
        folder: "/movies/Inception (2010)",
        videoPath: "/movies/Inception (2010)/Inception (2010).mkv",
      })
    ).toEqual({ tmdbId: 27205 });
    expect(index.lookup({ kind: "series", folder: "/mnt/user/tv/breaking bad" })).toEqual({
      tvdbId: 81189,
      tmdbId: 1396,
    });
    expect(index.lookup({ kind: "movie", folder: "/m/Heat (1995)" })).toEqual({
      imdbId: "tt0113277",
    });
  });

  test("a file name settles a shared folder; the folder alone doesn't", () => {
    expect(
      index.lookup({
        kind: "movie",
        folder: "/movies/Classics",
        videoPath: "/movies/Classics/Nosferatu.mkv",
      })
    ).toEqual({ tmdbId: 653 });
    expect(index.lookup({ kind: "movie", folder: "/movies/Classics" })).toBeNull();
  });
});
