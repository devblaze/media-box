import { resolveMappings } from "./categories";
import { analyzeDefinition, parseDefinition } from "./definition";
import { fetchAllDefinitions } from "./defs";
import type { CardigannDefinition, CatalogEntry } from "./types";

/**
 * Builds the browsable catalog of Cardigann definitions. Unsupported defs are
 * listed too (flagged with a reason) so the UI can show the full upstream
 * catalog and explain the gaps instead of silently hiding trackers.
 */

/** Does the definition advertise a TV/movie search mode (or such categories)? */
function supportsMode(def: CardigannDefinition, mode: string, categoryPrefix: number): boolean {
  const modes = def.caps?.modes ?? {};
  if (Object.prototype.hasOwnProperty.call(modes, mode)) return true;
  // Some defs omit modes but map plenty of categories; fall back to those.
  return resolveMappings(def.caps).some(
    (m) => Math.floor(m.torznabId / 1000) === Math.floor(categoryPrefix / 1000)
  );
}

/** Convert one parsed definition into its catalog row. */
export function toCatalogEntry(def: CardigannDefinition): CatalogEntry {
  const analyzed = analyzeDefinition(def);
  const categories = [...new Set(resolveMappings(def.caps).map((m) => m.torznabId))].sort(
    (a, b) => a - b
  );
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? "",
    language: def.language ?? "",
    links: def.links ?? [],
    supported: analyzed.supported,
    unsupportedReason: analyzed.unsupportedReason,
    categories,
    supportsTv: supportsMode(def, "tv-search", 5000),
    supportsMovies: supportsMode(def, "movie-search", 2000),
  };
}

/** Catalog assembly is expensive (hundreds of YAMLs); memoize per process. */
let memo: { at: number; entries: CatalogEntry[] } | null = null;
const MEMO_TTL_MS = 60 * 60 * 1000;

/**
 * Every PUBLIC definition upstream, with a supported/unsupported verdict.
 * Private/semi-private trackers are excluded outright — media-box's Cardigann
 * engine has no login support, so listing them would only be noise.
 *
 * The first call fetches the whole definitions directory (cached on disk for
 * 24h under CONFIG_DIR/cardigann-defs), so expect it to take a while cold;
 * every later call is served from cache.
 */
export async function listCatalog(): Promise<CatalogEntry[]> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.entries;
  const raw = await fetchAllDefinitions();
  const entries: CatalogEntry[] = [];
  for (const { yaml } of raw) {
    if (!yaml) continue;
    let def: CardigannDefinition;
    try {
      def = parseDefinition(yaml);
    } catch {
      // A definition we can't even parse as YAML isn't worth surfacing.
      continue;
    }
    if ((def.type ?? "").toLowerCase() !== "public") continue;
    entries.push(toCatalogEntry(def));
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  memo = { at: Date.now(), entries };
  return entries;
}
