import { search as torznabSearch, type TorznabItem, type TorznabQuery } from "./torznab";
import { getBuiltin } from "./builtin/registry";

/** The indexer fields the dispatcher needs — a subset of the `indexers` row. */
export interface IndexerRef {
  type: string;
  definition: string | null;
  url: string;
  apiKey: string | null;
}

/**
 * Run a search against an indexer regardless of its kind: a built-in scraper
 * (`type = "builtin"`) or an external Torznab feed. Both yield `TorznabItem[]`,
 * so callers stay agnostic.
 */
export function queryIndexer(indexer: IndexerRef, query: TorznabQuery): Promise<TorznabItem[]> {
  if (indexer.type === "builtin") {
    const def = getBuiltin(indexer.definition);
    if (!def) {
      return Promise.reject(new Error(`Unknown built-in indexer '${indexer.definition}'`));
    }
    return def.search(query);
  }
  return torznabSearch(indexer.url, indexer.apiKey, query);
}
