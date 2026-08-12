/**
 * Offline-only coverage for `testIndexer`: the cases that fail BEFORE any
 * network request (unknown built-in definition, missing Torznab URL). The
 * happy paths (a built-in's recent-feed search, Torznab `t=caps`) need a live
 * endpoint and are deliberately not simulated here — mocking global fetch for
 * them would pin these tests to implementation details.
 */
import { describe, expect, test } from "vitest";
import { testIndexer, type IndexerTestRef } from "./test-indexer";

const ref = (over: Partial<IndexerTestRef>): IndexerTestRef => ({
  type: "torznab",
  definition: null,
  url: "",
  apiKey: null,
  ...over,
});

describe("testIndexer (offline failure paths)", () => {
  test("builtin ref with an unknown definition fails without throwing", async () => {
    const res = await testIndexer(ref({ type: "builtin", definition: "totally-bogus" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/unknown/i);
    expect(res.message).toContain("totally-bogus");
    expect(res.caps).toBeUndefined();
  });

  test("builtin ref with a null definition is also unknown", async () => {
    const res = await testIndexer(ref({ type: "builtin", definition: null }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/unknown/i);
  });

  test("torznab ref with an empty URL reports the missing configuration", async () => {
    const res = await testIndexer(ref({ type: "torznab", url: "" }));
    expect(res.ok).toBe(false);
    expect(res.message).toBe("No Torznab URL configured");
    expect(res.caps).toBeUndefined();
  });

  test("latencyMs is a non-negative number even on immediate failures", async () => {
    for (const r of [
      await testIndexer(ref({ type: "builtin", definition: "nope" })),
      await testIndexer(ref({ type: "torznab", url: "" })),
    ]) {
      expect(typeof r.latencyMs).toBe("number");
      expect(Number.isFinite(r.latencyMs)).toBe(true);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});
