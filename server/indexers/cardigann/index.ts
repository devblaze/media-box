/**
 * Cardigann-lite: run Jackett/Prowlarr YAML indexer definitions natively.
 *
 * media-box fetches definitions from the Prowlarr/Indexers repo at runtime
 * (they're GPL, so nothing is vendored) and executes the public, GET-only,
 * login-free subset of the Cardigann schema against the tracker's HTML. The
 * result is the same `TorznabItem[]` shape the Torznab client and the built-in
 * scrapers produce, so the rest of the pipeline stays agnostic.
 *
 * Integration surface — everything callers need is exported here:
 *
 *   listCatalog()                                → CatalogEntry[]  (picker UI)
 *   searchCardigann(defId, baseUrlOverride, q)   → TorznabItem[]   (query.ts)
 *   testCardigann(defId, baseUrlOverride)        → {ok, message}   (test-indexer.ts)
 *   resolveDownloadLink(defId, detailsUrl)       → string | null   (grab time)
 */

export { listCatalog } from "./catalog";
export { searchCardigann, testCardigann, resolveDownloadLink } from "./search";
export type { CatalogEntry } from "./types";
