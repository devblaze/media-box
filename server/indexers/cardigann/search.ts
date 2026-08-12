import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import type { TorznabItem, TorznabQuery } from "../torznab";
import { resolveMappings, torznabCategoriesFor, trackerCategoriesFor } from "./categories";
import { analyzeDefinition, configDefaults, parseDefinition, searchPaths } from "./definition";
import { getDefinitionYaml } from "./defs";
import { applyFilters, applyFiltersLenient, parseIntSafe, parseSize } from "./filters";
import { evalTemplate, type TemplateContext } from "./template";
import type { AnalyzedDefinition, CardigannDefinition, SelectorBlock } from "./types";

const UA = "media-box/0.1";
const FETCH_TIMEOUT_MS = 30_000;
/** Cap per-def requestDelay so a 4-path definition can't stall a search. */
const MAX_PATH_DELAY_MS = 3_000;

/** Thrown when a required field can't be extracted; drops just that row. */
class RowError extends Error {}

/** Parsed+analyzed defs are memoized briefly — searches often hit the same
 * def many times in a burst (RSS + interactive + season pack lookups). */
const analyzedMemo = new Map<string, { at: number; analyzed: AnalyzedDefinition }>();
const ANALYZED_TTL_MS = 10 * 60 * 1000;

/** Load, parse, and analyze a definition by id (cached). */
export async function loadDefinition(defId: string): Promise<AnalyzedDefinition> {
  const hit = analyzedMemo.get(defId);
  if (hit && Date.now() - hit.at < ANALYZED_TTL_MS) return hit.analyzed;
  const yaml = await getDefinitionYaml(defId);
  const analyzed = analyzeDefinition(parseDefinition(yaml));
  analyzedMemo.set(defId, { at: Date.now(), analyzed });
  return analyzed;
}

/** Fold season/episode into free text the way Jackett does ("show S01E05"). */
function buildKeywords(query: TorznabQuery): string {
  const parts = [query.q?.trim() ?? ""];
  if (query.season !== undefined) {
    let se = `S${String(query.season).padStart(2, "0")}`;
    if (query.ep !== undefined) se += `E${String(query.ep).padStart(2, "0")}`;
    parts.push(se);
  }
  return parts.filter(Boolean).join(" ").trim();
}

/**
 * Build the flat template variable map. Variables live under their dotted
 * path (".Config.sort") because that's exactly how templates reference them.
 */
export function buildContext(
  def: CardigannDefinition,
  keywords: string,
  trackerCats: string[],
  query: TorznabQuery
): TemplateContext {
  const ctx: TemplateContext = {
    ".Keywords": keywords,
    ".Categories": trackerCats,
    // Jackett convention: True is the literal "True", False is empty — this
    // makes `eq .Config.somecheckbox .False` work with our string equality.
    ".True": "True",
    ".False": "",
    ".Query.Keywords": keywords,
    ".Query.Q": query.q?.trim() ?? "",
    ".Query.Type": query.t,
    ".Query.Season": query.season !== undefined ? String(query.season) : "",
    ".Query.Ep": query.ep !== undefined ? String(query.ep) : "",
    ".Query.Limit": String(query.limit ?? 100),
    ".Query.Offset": "0",
    ".Query.IMDBID": "",
    ".Query.IMDBIDShort": "",
    ".Query.TMDBID": "",
    ".Query.TVDBID": "",
    ".Query.Year": "",
    ".Today.Year": String(new Date().getUTCFullYear()),
  };
  for (const [name, value] of Object.entries(configDefaults(def))) {
    ctx[`.Config.${name}`] = value;
  }
  return ctx;
}

/** Fetch a page and decode it honoring the definition's declared encoding. */
async function fetchPage(url: string, encoding: string | undefined): Promise<string> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Tracker responded ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder(encoding?.toLowerCase() || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** Join a definition path with the base link, tolerating absolute URLs. */
function resolveSearchUrl(base: string, pathStr: string): string {
  if (/^https?:\/\//i.test(pathStr)) return pathStr;
  const normalBase = base.endsWith("/") ? base : `${base}/`;
  return new URL(pathStr.replace(/^\//, ""), normalBase).toString();
}

/** Append evaluated `inputs` to a URL; `$raw` is glued on unencoded. */
function applyInputs(url: string, inputs: Record<string, unknown> | undefined, ctx: TemplateContext): string {
  if (!inputs) return url;
  const u = new URL(url);
  let raw = "";
  for (const [key, value] of Object.entries(inputs)) {
    const evaluated = evalTemplate(String(value ?? ""), ctx);
    if (key === "$raw") {
      raw += evaluated;
    } else {
      u.searchParams.set(key, evaluated);
    }
  }
  let out = u.toString();
  if (raw) {
    const trimmed = raw.replace(/^[&?]+/, "");
    out += (out.includes("?") ? "&" : "?") + trimmed;
  }
  return out;
}

/**
 * Should this search path run for the mapped tracker categories? Paths can
 * scope themselves to categories, with a leading "!" entry meaning "all
 * except these" (mirrors Jackett's SearchPath matching).
 */
function pathMatchesCategories(pathCats: (string | number)[] | undefined, trackerCats: string[]): boolean {
  if (!pathCats?.length) return true;
  // No category constraint from the query — every path runs (RSS mode).
  if (trackerCats.length === 0) return true;
  const negated = String(pathCats[0]) === "!";
  const list = (negated ? pathCats.slice(1) : pathCats).map(String);
  const hit = trackerCats.some((c) => list.includes(c));
  return negated ? !hit : hit;
}

/** Case-insensitive whitespace-collapsed text of a selected element. */
function elementText(el: HTMLElement): string {
  return el.text.replace(/\s+/g, " ").trim();
}

/**
 * Extract one field value from a row scope. Returns null when the selector
 * matched nothing (caller applies optional/default semantics).
 */
function selectValue(scope: HTMLElement, block: SelectorBlock, ctx: TemplateContext): string | null {
  if (block.text !== undefined) {
    return evalTemplate(String(block.text), ctx);
  }
  let el: HTMLElement | null = scope;
  if (block.selector) {
    const selector = evalTemplate(block.selector, ctx);
    el = scope.querySelector(selector);
    if (!el) return null;
  }
  if (block.case) {
    // First case selector that matches the element (or its subtree) wins.
    // Re-parsing outerHTML lets querySelector test the element itself too.
    const probe = parseHtml(el.outerHTML);
    for (const [caseSelector, caseValue] of Object.entries(block.case)) {
      if (caseSelector === "*" || probe.querySelector(evalTemplate(caseSelector, ctx))) {
        return evalTemplate(String(caseValue), ctx);
      }
    }
    return null;
  }
  if (block.attribute) {
    const attr = el.getAttribute(block.attribute);
    return attr === undefined ? null : attr;
  }
  if (block.remove) {
    // Strip unwanted children on a clone so later fields see the intact row.
    const clone = parseHtml(el.outerHTML);
    for (const junk of clone.querySelectorAll(evalTemplate(block.remove, ctx))) junk.remove();
    return clone.text.replace(/\s+/g, " ").trim();
  }
  return elementText(el);
}

/** Full field pipeline: select → optional/default → filters. */
function extractField(name: string, scope: HTMLElement, block: SelectorBlock, ctx: TemplateContext): string {
  let value: string | null;
  try {
    value = selectValue(scope, block, ctx);
  } catch (err) {
    throw new RowError(`field '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
  if (value === null || value === "") {
    if (block.optional || block.default !== undefined) {
      return block.default !== undefined ? evalTemplate(String(block.default), ctx) : "";
    }
    if (value === null) throw new RowError(`field '${name}': selector matched nothing`);
  }
  try {
    return applyFilters(value, block.filters, ctx);
  } catch (err) {
    if (block.optional) {
      return block.default !== undefined ? evalTemplate(String(block.default), ctx) : "";
    }
    throw new RowError(`field '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Group rows when `rows.after` says N follow-up rows belong to each result. */
function groupRows(rows: HTMLElement[], after: number): HTMLElement[] {
  if (!after || after <= 0) return rows;
  const grouped: HTMLElement[] = [];
  for (let i = 0; i < rows.length; i += after + 1) {
    const html = rows
      .slice(i, i + after + 1)
      .map((r) => r.outerHTML)
      .join("");
    grouped.push(parseHtml(html) as unknown as HTMLElement);
  }
  return grouped;
}

/** Resolve a possibly-relative scraped URL against the page we fetched. */
function resolveLink(value: string, pageUrl: string): string {
  if (!value) return "";
  if (/^(magnet:|https?:\/\/)/i.test(value)) return value;
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return value;
  }
}

function buildMagnetFromHash(infoHash: string, title: string): string {
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
}

/** Does the item survive the query's category filter? Parents match children. */
function itemMatchesQueryCats(itemCats: number[], queryCats: number[] | undefined): boolean {
  if (!queryCats?.length || itemCats.length === 0) return true;
  return itemCats.some((c) =>
    queryCats.some((qc) => qc === c || (qc % 1000 === 0 && Math.floor(c / 1000) === Math.floor(qc / 1000)))
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run a search against a Cardigann definition. `baseUrlOverride` lets the
 * caller pin a specific mirror; otherwise the definition's first link is used.
 */
export async function searchCardigann(
  defId: string,
  baseUrlOverride: string | null,
  query: TorznabQuery
): Promise<TorznabItem[]> {
  const analyzed = await loadDefinition(defId);
  if (!analyzed.supported) {
    throw new Error(`Definition '${defId}' is not supported: ${analyzed.unsupportedReason}`);
  }
  const def = analyzed.definition;
  const search = def.search;
  if (!search?.rows?.selector || !search.fields) {
    throw new Error(`Definition '${defId}' has no usable search block`);
  }

  const mappings = resolveMappings(def.caps);
  const trackerCats = trackerCategoriesFor(mappings, query.cat ?? []);
  const rawKeywords = buildKeywords(query);
  const baseCtx = buildContext(def, rawKeywords, trackerCats, query);
  // keywordsfilters run on the raw keywords before templates see them.
  const keywords = applyFiltersLenient(rawKeywords, search.keywordsfilters, baseCtx).trim();
  baseCtx[".Keywords"] = keywords;
  baseCtx[".Query.Keywords"] = keywords;

  const base = (baseUrlOverride?.trim() || def.links?.[0] || "").trim();
  if (!base) throw new Error(`Definition '${defId}' has no base URL`);

  const paths = searchPaths(def).filter((p) => pathMatchesCategories(p.categories, trackerCats));
  const items: TorznabItem[] = [];
  const seen = new Set<string>();
  const limit = query.limit ?? 100;
  const delayMs = Math.min((def.requestDelay ?? 0) * 1000, MAX_PATH_DELAY_MS);

  let firstError: Error | null = null;
  let fetchedAny = false;
  for (const [index, searchPath] of paths.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    try {
      // Values substituted into the URL path must be URL-escaped (keywords
      // with spaces/slashes); literal template text must pass through as-is.
      const pathStr = evalTemplate(searchPath.path, baseCtx, { escape: encodeURIComponent });
      let url = resolveSearchUrl(base, pathStr);
      const inputs = {
        ...(searchPath.inheritinputs === false ? {} : (search.inputs ?? {})),
        ...(searchPath.inputs ?? {}),
      };
      url = applyInputs(url, inputs, baseCtx);

      let html = await fetchPage(url, def.encoding);
      if (search.preprocessingfilters?.length) {
        html = applyFilters(html, search.preprocessingfilters, baseCtx);
      }
      fetchedAny = true;

      for (const item of parseSearchHtml(def, html, url, baseCtx)) {
        const key = item.guid || item.link;
        if (seen.has(key)) continue;
        seen.add(key);
        if (itemMatchesQueryCats(item.categories, query.cat)) items.push(item);
      }
    } catch (err) {
      // Remember the first failure but let remaining paths try — mirrors how
      // multi-path defs behave in Jackett when one page layout changes.
      if (!firstError) firstError = err instanceof Error ? err : new Error(String(err));
    }
    if (items.length >= limit) break;
  }

  if (!fetchedAny && firstError) throw firstError;
  return items.slice(0, limit);
}

/**
 * Scrape one already-fetched results page into items. Split out from
 * `searchCardigann` so the whole extraction path (rows selector → fields →
 * filters → URL resolution → category mapping) is unit-testable without
 * touching the network.
 */
export function parseSearchHtml(
  def: CardigannDefinition,
  html: string,
  pageUrl: string,
  ctx: TemplateContext
): TorznabItem[] {
  const search = def.search;
  if (!search?.rows?.selector || !search.fields) return [];
  const mappings = resolveMappings(def.caps);
  const root = parseHtml(html);
  const rowsSelector = evalTemplate(search.rows.selector, ctx);
  const rows = groupRows(root.querySelectorAll(rowsSelector), search.rows.after ?? 0);

  const items: TorznabItem[] = [];
  for (const row of rows) {
    try {
      const item = extractItem(row, search.fields, ctx, pageUrl, mappings);
      if (item) items.push(item);
    } catch {
      // A malformed row (ad banner, or a header row the selector caught)
      // shouldn't kill the result set — skip just that row.
    }
  }
  return items;
}

/** Turn one parsed row into a TorznabItem (null = not a real result row). */
function extractItem(
  row: HTMLElement,
  fields: Record<string, SelectorBlock>,
  baseCtx: TemplateContext,
  pageUrl: string,
  mappings: ReturnType<typeof resolveMappings>
): TorznabItem | null {
  // Fields are evaluated in definition order and become .Result.* variables,
  // which later fields' templates reference (pseudo-fields like title_raw).
  const ctx: TemplateContext = { ...baseCtx };
  const values: Record<string, string> = {};
  for (const [name, block] of Object.entries(fields)) {
    const value = extractField(name, row, block ?? {}, ctx);
    values[name] = value;
    ctx[`.Result.${name}`] = value;
  }

  const title = (values.title ?? "").trim();
  if (!title) return null;

  const details = values.details ? resolveLink(values.details, pageUrl) : "";
  let download = values.download ? resolveLink(values.download, pageUrl) : "";
  let magnet = values.magnet ? resolveLink(values.magnet, pageUrl) : "";
  const infoHash = (values.infohash ?? "").trim().toLowerCase() || undefined;
  if (!magnet && download.startsWith("magnet:")) magnet = download;
  if (!magnet && !download && infoHash) magnet = buildMagnetFromHash(infoHash, title);
  if (!download) download = magnet || details;
  if (!download) return null;

  const publishDateRaw = values.date?.trim();
  const publishDateMs = publishDateRaw ? Date.parse(publishDateRaw) : NaN;

  return {
    guid: details || download,
    title,
    size: values.size ? parseSize(values.size) : 0,
    link: download,
    magnetUrl: magnet || undefined,
    infoHash,
    seeders: values.seeders !== undefined ? parseIntSafe(values.seeders) : null,
    leechers: values.leechers !== undefined ? parseIntSafe(values.leechers) : null,
    publishDate: Number.isNaN(publishDateMs) ? undefined : new Date(publishDateMs).toUTCString(),
    categories: values.category ? torznabCategoriesFor(mappings, values.category) : [],
  };
}

/**
 * Health check: run an empty-keywords search (most public defs answer that
 * with a "latest torrents" page). Zero rows is still a pass — reachability
 * and parseability are what's being tested, not content.
 */
export async function testCardigann(
  defId: string,
  baseUrlOverride: string | null
): Promise<{ ok: boolean; message: string }> {
  try {
    const items = await searchCardigann(defId, baseUrlOverride, { t: "search", limit: 20 });
    if (items.length === 0) {
      return { ok: true, message: "Reachable, but the latest-releases page yielded 0 parsed rows" };
    }
    return { ok: true, message: `OK — parsed ${items.length} results` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Many public defs only expose a details-page link in search results; the
 * actual .torrent/magnet link needs a second fetch guided by the definition's
 * `download.selectors`. Callers can use this at grab time. Returns null when
 * the definition has no download block or nothing matched.
 */
export async function resolveDownloadLink(
  defId: string,
  detailsUrl: string
): Promise<string | null> {
  const analyzed = await loadDefinition(defId);
  const def = analyzed.definition;
  const selectors = def.download?.selectors ?? [];
  if (selectors.length === 0) return null;
  const ctx = buildContext(def, "", [], { t: "search" });
  const html = await fetchPage(detailsUrl, def.encoding);
  const root = parseHtml(html);
  for (const sel of selectors) {
    if (!sel.selector) continue;
    const el = root.querySelector(evalTemplate(sel.selector, ctx));
    if (!el) continue;
    const raw = sel.attribute ? el.getAttribute(sel.attribute) : elementText(el);
    if (!raw) continue;
    const value = applyFiltersLenient(raw, sel.filters, ctx);
    if (value) return resolveLink(value, detailsUrl);
  }
  return null;
}
