import { parse as parseYaml } from "yaml";
import { knownFilter } from "./filters";
import { validateTemplate } from "./template";
import type {
  AnalyzedDefinition,
  CardigannDefinition,
  FilterBlock,
  SearchPathBlock,
  SelectorBlock,
} from "./types";

/**
 * Parse a raw Cardigann YAML document. Duplicate keys are legal in the format
 * (they express fallbacks in Jackett) — we let later values win rather than
 * erroring, which matches how most YAML consumers behave.
 */
export function parseDefinition(yamlText: string): CardigannDefinition {
  const doc: unknown = parseYaml(yamlText, { uniqueKeys: false });
  if (!doc || typeof doc !== "object") throw new Error("definition is not a YAML mapping");
  const def = doc as CardigannDefinition;
  if (!def.id || !def.name) throw new Error("definition missing id/name");
  return def;
}

/** Every template string a selector block can carry, for validation. */
function selectorTemplates(block: SelectorBlock | undefined): string[] {
  if (!block) return [];
  const out: string[] = [];
  // YAML gives us numbers for things like `text: 1` (uploadvolumefactor), so
  // every value is stringified before it reaches the template machinery.
  if (block.selector) out.push(String(block.selector));
  if (block.text !== undefined && block.text !== null) out.push(String(block.text));
  if (block.default !== undefined && block.default !== null) out.push(String(block.default));
  for (const v of Object.values(block.case ?? {})) out.push(String(v));
  for (const f of block.filters ?? []) {
    const args = Array.isArray(f.args) ? f.args : f.args !== undefined ? [f.args] : [];
    for (const a of args) if (typeof a === "string") out.push(a);
  }
  return out;
}

function filterNames(filters: FilterBlock[] | undefined): string[] {
  return (filters ?? []).map((f) => f.name);
}

/** Normalize `search.path` / `search.paths` into a single list. */
export function searchPaths(def: CardigannDefinition): SearchPathBlock[] {
  const search = def.search;
  if (!search) return [];
  if (search.paths?.length) return search.paths;
  if (search.path) return [{ path: search.path, method: search.method }];
  return [];
}

/**
 * Decide whether the v1 engine can run this definition, and why not if it
 * can't. The philosophy: NEVER run a definition we only half-understand —
 * a clean "unsupported" beats silently-wrong results.
 */
export function analyzeDefinition(def: CardigannDefinition): AnalyzedDefinition {
  const unsupported = (reason: string): AnalyzedDefinition => ({
    definition: def,
    supported: false,
    unsupportedReason: reason,
  });

  if ((def.type ?? "").toLowerCase() !== "public") {
    return unsupported("only public trackers are supported (this one needs an account)");
  }
  if (def.login !== undefined && def.login !== null) {
    return unsupported("requires a login flow");
  }
  if (!def.search) return unsupported("definition has no search block");

  const paths = searchPaths(def);
  if (paths.length === 0) return unsupported("definition has no search paths");
  for (const p of paths) {
    const method = (p.method ?? def.search.method ?? "get").toLowerCase();
    // A few defs pick the verb with a template ("{{ if .Keywords }}post{{ else }}get{{ end }}"),
    // which means they POST for some queries — out of scope either way.
    if (method.includes("{{")) return unsupported("conditional POST searches are not supported");
    if (method !== "get") return unsupported(`${method.toUpperCase()} searches are not supported`);
    const responseType = (p.response?.type ?? "html").toLowerCase();
    if (responseType !== "html") {
      return unsupported(`${responseType.toUpperCase()} search responses are not supported`);
    }
  }

  if (!def.search.rows?.selector) return unsupported("definition has no rows selector");
  if (def.search.rows.dateheaders) return unsupported("rows.dateheaders is not supported");

  const fields = def.search.fields ?? {};
  if (!fields.title) return unsupported("definition has no title field");
  if (!fields.download && !fields.magnet && !fields.details && !fields.infohash) {
    return unsupported("definition has no download/magnet/details field");
  }

  // Every filter must be one we implement — otherwise values would come out
  // subtly wrong (dates unparsed, titles unmunged) and poison the pipeline.
  const allFilters: string[] = [...filterNames(def.search.preprocessingfilters)];
  for (const block of Object.values(fields)) allFilters.push(...filterNames(block?.filters));
  for (const name of allFilters) {
    if (!knownFilter(name)) return unsupported(`filter '${name}' is not supported`);
  }

  // Dry-run every template to catch constructs our mini-evaluator lacks.
  const templates: string[] = [];
  for (const p of paths) {
    templates.push(p.path);
    for (const v of Object.values(p.inputs ?? {})) templates.push(String(v));
  }
  for (const v of Object.values(def.search.inputs ?? {})) templates.push(String(v));
  if (def.search.rows.selector) templates.push(def.search.rows.selector);
  for (const block of Object.values(fields)) templates.push(...selectorTemplates(block));
  for (const t of templates) {
    try {
      validateTemplate(t);
    } catch (err) {
      return unsupported(`template not supported: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!def.links?.length) return unsupported("definition has no links");

  return { definition: def, supported: true };
}

/**
 * Build the `.Config.*` template variables from settings defaults. media-box
 * doesn't surface per-indexer Cardigann settings yet, so defaults are the
 * config — mirroring Jackett, checkboxes become "True"/"" so `eq .Config.x
 * .True` comparisons work.
 */
export function configDefaults(def: CardigannDefinition): Record<string, string> {
  const config: Record<string, string> = {};
  for (const field of def.settings ?? []) {
    const type = field.type ?? "text";
    // info* fields are UI-only prose, not config values.
    if (type.startsWith("info")) continue;
    if (type === "checkbox") {
      config[field.name] = field.default === true || field.default === "true" ? "True" : "";
    } else {
      config[field.name] = field.default === undefined || field.default === null ? "" : String(field.default);
    }
  }
  return config;
}
