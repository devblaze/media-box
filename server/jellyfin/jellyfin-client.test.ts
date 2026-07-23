import { describe, expect, it } from "vitest";
import { providerId, ticksToSeconds } from "./jellyfin-client";

describe("ticksToSeconds", () => {
  it.each([
    [0, 0],
    [undefined, 0],
    [null, 0],
    [10_000_000, 1],
    [15_000_000, 1], // floors partial seconds
    [36_000_000_000, 3600],
  ] as const)("%s ticks -> %i s", (ticks, expected) => {
    expect(ticksToSeconds(ticks)).toBe(expected);
  });
});

describe("providerId", () => {
  const item = { Id: "x", ProviderIds: { Tmdb: "27205", tvdb: "267440", Imdb: " tt1375666 " } };

  it("matches keys case-insensitively", () => {
    expect(providerId(item, "tmdb")).toBe("27205");
    expect(providerId(item, "Tvdb")).toBe("267440");
  });

  it("trims values and treats empties as missing", () => {
    expect(providerId(item, "imdb")).toBe("tt1375666");
    expect(providerId({ Id: "y", ProviderIds: { Tmdb: "  " } }, "tmdb")).toBeNull();
    expect(providerId({ Id: "z" }, "tmdb")).toBeNull();
  });
});
