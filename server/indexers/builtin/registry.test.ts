import { describe, expect, test } from "vitest";
import { findBuiltinKeyByName, getBuiltin, listBuiltins } from "./registry";

describe("listBuiltins", () => {
  test("returns the 4 built-ins with their stable keys", () => {
    const builtins = listBuiltins();
    expect(builtins).toHaveLength(4);
    expect(builtins.map((b) => b.key).sort()).toEqual(["apibay", "eztv", "nyaa", "yts"]);
  });

  test("entries carry picker metadata but no search function", () => {
    for (const b of listBuiltins()) {
      expect(typeof b.name).toBe("string");
      expect(b.name.length).toBeGreaterThan(0);
      expect(typeof b.description).toBe("string");
      expect(typeof b.site).toBe("string");
      expect(typeof b.supportsTv).toBe("boolean");
      expect(typeof b.supportsMovies).toBe("boolean");
      expect(Array.isArray(b.categories)).toBe(true);
      // Public metadata only — the search fn must not leak into the picker payload.
      expect("search" in b).toBe(false);
    }
  });
});

describe("getBuiltin", () => {
  test("resolves a known key and rejects unknown / missing keys", () => {
    expect(getBuiltin("apibay")?.key).toBe("apibay");
    expect(getBuiltin("nope")).toBeUndefined();
    expect(getBuiltin(null)).toBeUndefined();
    expect(getBuiltin(undefined)).toBeUndefined();
  });
});

describe("findBuiltinKeyByName", () => {
  test('"The Pirate Bay" (Jackett display name) matches apibay', () => {
    expect(findBuiltinKeyByName("The Pirate Bay")).toBe("apibay");
  });

  test('"thepiratebay" (Jackett URL slug) matches apibay', () => {
    expect(findBuiltinKeyByName("thepiratebay")).toBe("apibay");
  });

  test('"TPB" matches apibay via exact short alias', () => {
    expect(findBuiltinKeyByName("TPB")).toBe("apibay");
  });

  test('"Nyaa.si (Jackett)" matches nyaa', () => {
    expect(findBuiltinKeyByName("Nyaa.si (Jackett)")).toBe("nyaa");
  });

  test('"yify" matches yts', () => {
    expect(findBuiltinKeyByName("yify")).toBe("yts");
  });

  test('"EZTV" matches eztv', () => {
    expect(findBuiltinKeyByName("EZTV")).toBe("eztv");
  });

  test("a 1-char name never matches anything (4-char substring floor)", () => {
    // Each of these is a real substring of some alias — but too short to count.
    for (const short of ["y", "t", "e", "n", "a"]) {
      expect(findBuiltinKeyByName(short)).toBeNull();
    }
  });

  test("unrelated indexer names return null", () => {
    expect(findBuiltinKeyByName("RARBG")).toBeNull();
    expect(findBuiltinKeyByName("1337x")).toBeNull();
    expect(findBuiltinKeyByName("Some Private Tracker")).toBeNull();
  });

  test("empty / punctuation-only input returns null", () => {
    expect(findBuiltinKeyByName("")).toBeNull();
    expect(findBuiltinKeyByName("---")).toBeNull();
  });
});
