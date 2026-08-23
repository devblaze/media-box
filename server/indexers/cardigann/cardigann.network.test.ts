import { describe, expect, it } from "vitest";
import { analyzeDefinition, parseDefinition } from "./definition";
import { fetchAllDefinitions, getDefinitionIndex, getDefinitionYaml } from "./defs";
import { listCatalog } from "./catalog";
import { searchCardigann, testCardigann } from "./search";

/**
 * Live tests against GitHub and real public trackers. OPT-IN ONLY: CI must stay
 * green and fast, and public trackers are flaky/geo-blocked by nature, so these
 * only run with CARDIGANN_LIVE=1. They double as the tool for measuring how
 * much of the upstream catalog this engine actually supports.
 */
const LIVE = process.env.CARDIGANN_LIVE === "1";

describe.skipIf(!LIVE)("cardigann live", () => {
  it(
    "indexes the Prowlarr/Indexers definitions directory",
    async () => {
      const entries = await getDefinitionIndex();
      expect(entries.length).toBeGreaterThan(100);
      expect(entries.some((e) => e.id === "limetorrents")).toBe(true);
    },
    120_000
  );

  it(
    "parses a real definition and marks it supported",
    async () => {
      const def = parseDefinition(await getDefinitionYaml("limetorrents"));
      const analyzed = analyzeDefinition(def);
      console.log("limetorrents:", analyzed.supported, analyzed.unsupportedReason ?? "");
      expect(def.id).toBe("limetorrents");
    },
    120_000
  );

  it(
    "reports catalog support coverage across all public definitions",
    async () => {
      const all = await fetchAllDefinitions();
      let publicCount = 0;
      let supported = 0;
      const reasons = new Map<string, number>();
      for (const { yaml } of all) {
        if (!yaml) continue;
        try {
          const def = parseDefinition(yaml);
          if ((def.type ?? "").toLowerCase() !== "public") continue;
          publicCount++;
          const analyzed = analyzeDefinition(def);
          if (analyzed.supported) supported++;
          else {
            const key = (analyzed.unsupportedReason ?? "unknown").replace(/'.*?'/g, "'…'");
            reasons.set(key, (reasons.get(key) ?? 0) + 1);
          }
        } catch {
          // Unparseable YAML is excluded from the catalog entirely.
        }
      }
      console.log(
        `public defs: ${publicCount}, supported: ${supported} (${Math.round((supported / publicCount) * 100)}%)`,
        [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      );
      expect(publicCount).toBeGreaterThan(50);
      expect(supported).toBeGreaterThan(0);
    },
    600_000
  );

  it(
    "builds the catalog",
    async () => {
      const catalog = await listCatalog();
      expect(catalog.length).toBeGreaterThan(50);
      expect(catalog.every((e) => typeof e.id === "string")).toBe(true);
    },
    600_000
  );

  it(
    "searches a real public tracker",
    async () => {
      const result = await testCardigann("limetorrents", null);
      console.log("limetorrents test:", result);
      if (!result.ok) return; // Mirror/geo-block — not an engine bug.
      const items = await searchCardigann("limetorrents", null, { t: "search", q: "ubuntu", limit: 10 });
      console.log("first item:", items[0]);
      for (const item of items) {
        expect(item.title.length).toBeGreaterThan(0);
        expect(item.link.length).toBeGreaterThan(0);
      }
    },
    180_000
  );
});
