import { getCaps, type TorznabCaps } from "./torznab";
import { getBuiltin } from "./builtin/registry";
import { testCardigann } from "./cardigann";

/** The indexer fields a reachability test needs — a subset of the `indexers` row. */
export interface IndexerTestRef {
  type: string;
  definition: string | null;
  url: string;
  apiKey: string | null;
}

export interface IndexerTestResult {
  ok: boolean;
  message: string;
  /** Round-trip time of the probe, in milliseconds. */
  latencyMs: number;
  caps?: TorznabCaps;
}

/**
 * Probe a single indexer for reachability. Built-ins run their recent-feed search
 * (empty query = RSS mode); Torznab indexers fetch `t=caps`. Never throws — a
 * failure comes back as `{ ok: false, message }` — so it's safe to fan out over
 * every indexer for a "test all" without one bad feed rejecting the batch.
 */
export async function testIndexer(ref: IndexerTestRef): Promise<IndexerTestResult> {
  const started = Date.now();
  const done = (r: Omit<IndexerTestResult, "latencyMs">): IndexerTestResult => ({
    ...r,
    latencyMs: Date.now() - started,
  });

  if (ref.type === "builtin") {
    const def = getBuiltin(ref.definition);
    if (!def) return done({ ok: false, message: `Unknown built-in indexer '${ref.definition}'` });
    try {
      const items = await def.search({ t: def.supportsMovies ? "movie" : "search", q: "", limit: 5 });
      return done({ ok: true, message: `Reachable — ${items.length} recent releases` });
    } catch (err) {
      return done({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (ref.type === "cardigann") {
    if (!ref.definition) return done({ ok: false, message: "No definition id configured" });
    const res = await testCardigann(ref.definition, ref.url || null);
    return done(res);
  }

  // Torznab.
  if (!ref.url) return done({ ok: false, message: "No Torznab URL configured" });
  try {
    const caps = await getCaps(ref.url, ref.apiKey ?? null);
    return done({
      ok: true,
      message: `Reachable — tv:${caps.tvSearchAvailable ? "yes" : "no"} movie:${
        caps.movieSearchAvailable ? "yes" : "no"
      } · ${caps.categories.length} categories`,
      caps,
    });
  } catch (err) {
    return done({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}
