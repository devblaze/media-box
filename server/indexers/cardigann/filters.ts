import { evalTemplate, toJsRegExp, type TemplateContext } from "./template";
import { parseFuzzyDate, parseWithLayout } from "./dates";
import type { FilterBlock } from "./types";

/**
 * Cardigann selector filters — small string transforms chained after
 * extraction. This is the subset that covers effectively all public
 * definitions; `knownFilter` lets the analyzer flag defs that need more.
 */

export class FilterError extends Error {}

const KNOWN_FILTERS = new Set([
  "querystring",
  "regexp",
  "re_replace",
  "replace",
  "split",
  "trim",
  "prepend",
  "append",
  "tolower",
  "toupper",
  "urldecode",
  "urlencode",
  "htmldecode",
  "timeparse",
  "dateparse",
  "fuzzytime",
  "timeago",
  "validate",
  "diacritics",
]);

/** Is this a filter the engine implements? (Used for the supported check.) */
export function knownFilter(name: string): boolean {
  return KNOWN_FILTERS.has(name);
}

/** Normalize a filter's args to a string array, template-evaluating each —
 * definitions routinely embed `{{ .Config.x }}` inside filter arguments. */
function argList(args: unknown, ctx: TemplateContext): string[] {
  if (args === undefined || args === null) return [];
  const list = Array.isArray(args) ? args : [args];
  return list.map((a) => evalTemplate(String(a), ctx));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the HTML entities that actually show up in tracker markup. */
export function htmlDecode(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Apply one named filter. Throws FilterError on hard failures (no regexp
 * match, unknown filter) — callers decide whether `optional` swallows it. */
function applyFilter(name: string, value: string, args: string[]): string {
  switch (name) {
    case "querystring": {
      // Pull one parameter out of a URL-ish string ("?id=3&x=y" → id → "3").
      const param = args[0] ?? "";
      const queryPart = value.includes("?") ? value.slice(value.indexOf("?") + 1) : value;
      const found = new URLSearchParams(queryPart).get(param);
      if (found === null) throw new FilterError(`querystring: no param '${param}' in '${value}'`);
      return found;
    }
    case "regexp": {
      const re = toJsRegExp(args[0] ?? "");
      const m = re.exec(value);
      if (!m) throw new FilterError(`regexp: no match for ${args[0]}`);
      // First capture group when present, else the whole match (Jackett-compatible).
      return m[1] !== undefined ? m[1] : m[0];
    }
    case "re_replace":
      return value.replace(toJsRegExp(args[0] ?? "", "g"), args[1] ?? "");
    case "replace":
      return value.split(args[0] ?? "").join(args[1] ?? "");
    case "split": {
      const parts = value.split(args[0] ?? " ");
      let idx = Number(args[1] ?? 0);
      if (idx < 0) idx = parts.length + idx;
      const part = parts[idx];
      if (part === undefined) throw new FilterError(`split: no part ${args[1]} in '${value}'`);
      return part;
    }
    case "trim": {
      if (args[0] !== undefined && args[0] !== "") {
        const ch = args[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return value.replace(new RegExp(`^(?:${ch})+|(?:${ch})+$`, "g"), "");
      }
      return value.trim();
    }
    case "prepend":
      return (args[0] ?? "") + value;
    case "append":
      return value + (args[0] ?? "");
    case "tolower":
      return value.toLowerCase();
    case "toupper":
      return value.toUpperCase();
    case "urldecode":
      try {
        return decodeURIComponent(value.replace(/\+/g, " "));
      } catch {
        return value;
      }
    case "urlencode":
      return encodeURIComponent(value);
    case "htmldecode":
      return htmlDecode(value);
    case "timeparse":
    case "dateparse": {
      // Best-effort: a layout miss falls through to Date.parse, and a total
      // miss keeps the raw string — a bad date shouldn't kill the whole row.
      const layout = args[0];
      const d = (layout ? parseWithLayout(value, layout) : null) ?? parseFuzzyDate(value);
      return d ? d.toISOString() : value;
    }
    case "fuzzytime":
    case "timeago": {
      const d = parseFuzzyDate(value);
      return d ? d.toISOString() : value;
    }
    case "validate": {
      // Keep the value only if it's in the allowed list (comma-separated).
      const allowed = (args[0] ?? "").split(",").map((s) => s.trim().toLowerCase());
      const hits = value
        .split(/\s+/)
        .filter((word) => allowed.includes(word.toLowerCase()));
      return hits.join(" ");
    }
    case "diacritics":
      // args[0] is "replace" in every real def: strip combining marks.
      return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    default:
      throw new FilterError(`unsupported filter '${name}'`);
  }
}

/** Run a filter chain over a value, template-evaluating args against `ctx`. */
export function applyFilters(value: string, filters: FilterBlock[] | undefined, ctx: TemplateContext): string {
  let out = value;
  for (const f of filters ?? []) {
    out = applyFilter(f.name, out, argList(f.args, ctx));
  }
  return out;
}

/**
 * Like applyFilters but silently skips filters that fail or are unknown —
 * used for `keywordsfilters`, where Jackett-only extras (e.g. "andmatch")
 * shouldn't break the search, just degrade it.
 */
export function applyFiltersLenient(
  value: string,
  filters: FilterBlock[] | undefined,
  ctx: TemplateContext
): string {
  let out = value;
  for (const f of filters ?? []) {
    try {
      out = applyFilter(f.name, out, argList(f.args, ctx));
    } catch {
      // Deliberately ignored: keywords filters are an optimization.
    }
  }
  return out;
}

/**
 * Parse human sizes ("1.2 GB", "700MiB", "1,024.5 mb") into bytes. Uses 1024
 * multiples like Jackett so seed-size comparisons line up across indexers.
 */
export function parseSize(raw: string): number {
  const cleaned = raw.replace(/,/g, "").replace(/\u00a0/g, " ").trim();
  const m = /^([\d.]+)\s*([KMGTP]?I?B?)?$/i.exec(cleaned);
  if (!m) return 0;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return 0;
  const unit = (m[2] ?? "B").toUpperCase().replace("I", "");
  const powers: Record<string, number> = { B: 0, KB: 1, K: 1, MB: 2, M: 2, GB: 3, G: 3, TB: 4, T: 4, PB: 5, P: 5 };
  const power = powers[unit] ?? 0;
  return Math.round(num * 1024 ** power);
}

/** Parse "1,234" / "5.2k" style seeder/leecher counts. Null when not a number. */
export function parseIntSafe(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, "").trim();
  const km = /^([\d.]+)k$/i.exec(cleaned);
  if (km) return Math.round(Number(km[1]) * 1000);
  const n = Number.parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}
