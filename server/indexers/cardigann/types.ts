/**
 * TypeScript mirror of the Cardigann YAML definition schema, as used by the
 * Prowlarr/Indexers repo (see CardigannDefinition.cs upstream). Only the subset
 * media-box's Cardigann-lite engine understands is typed strictly; everything
 * else is kept loose so parsing never explodes on fields we ignore.
 */

/** One `filters:` entry on a selector — e.g. `{ name: "regexp", args: "..." }`. */
export interface FilterBlock {
  name: string;
  /** Scalar or array; shape depends on the filter (regexp takes a string,
   * re_replace takes [pattern, replacement], split takes [sep, index], ...). */
  args?: unknown;
}

/** A value extractor: CSS selector or literal `text`, plus post-processing. */
export interface SelectorBlock {
  selector?: string;
  /** Literal value (may contain template placeholders) instead of a selector. */
  text?: string;
  attribute?: string;
  /** CSS selector of child elements to strip before reading text. */
  remove?: string;
  optional?: boolean;
  default?: string;
  filters?: FilterBlock[];
  /** Map of CSS selector → literal value; first selector that matches wins. */
  case?: Record<string, string>;
}

export interface CategoryMapping {
  /** Tracker-side category id (string or number in the YAML). */
  id: string | number;
  /** Torznab category NAME, e.g. "Movies/HD" or "TV" (mapped to ids by us). */
  cat: string;
  desc?: string;
  default?: boolean;
}

export interface CapsBlock {
  /** Legacy flat form: tracker cat id → Torznab category name. */
  categories?: Record<string, string>;
  categorymappings?: CategoryMapping[];
  /** e.g. { search: ["q"], "tv-search": ["q", "season", "ep"] } */
  modes?: Record<string, string[]>;
  allowrawsearch?: boolean;
}

export interface SettingsField {
  name: string;
  type?: string;
  label?: string;
  default?: unknown;
  options?: Record<string, string>;
}

export interface SearchPathBlock {
  path: string;
  method?: string;
  /** Tracker cat ids this path serves; `["!", ...]` inverts the match. */
  categories?: (string | number)[];
  inputs?: Record<string, unknown>;
  inheritinputs?: boolean;
  followredirect?: boolean;
  response?: { type?: string; noResultsMessage?: string };
}

export interface RowsBlock extends SelectorBlock {
  /** Number of extra rows following each result row that belong to it. */
  after?: number;
  multiple?: boolean;
  dateheaders?: SelectorBlock;
  count?: SelectorBlock;
}

export interface SearchBlock {
  path?: string;
  paths?: SearchPathBlock[];
  method?: string;
  headers?: Record<string, string[] | string>;
  keywordsfilters?: FilterBlock[];
  allowEmptyInputs?: boolean;
  inputs?: Record<string, unknown>;
  error?: unknown;
  preprocessingfilters?: FilterBlock[];
  rows?: RowsBlock;
  fields?: Record<string, SelectorBlock>;
}

export interface DownloadBlock {
  selectors?: { selector?: string; attribute?: string; filters?: FilterBlock[] }[];
  method?: string;
  before?: unknown;
  infohash?: unknown;
}

/** The whole YAML document (subset; unknown blocks land in the index type). */
export interface CardigannDefinition {
  id: string;
  name: string;
  description?: string;
  language?: string;
  type?: string;
  encoding?: string;
  requestDelay?: number;
  links?: string[];
  legacylinks?: string[];
  followredirect?: boolean;
  settings?: SettingsField[];
  caps?: CapsBlock;
  /** Presence ⇒ the tracker needs auth; such defs are unsupported in v1. */
  login?: unknown;
  search?: SearchBlock;
  download?: DownloadBlock;
}

/** Catalog entry surfaced to the UI/API for one public definition. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  language: string;
  links: string[];
  supported: boolean;
  unsupportedReason?: string;
  /** Unique Torznab category ids derived from categorymappings. */
  categories: number[];
  supportsTv: boolean;
  supportsMovies: boolean;
}

/** A definition plus the engine's verdict on whether it can run it. */
export interface AnalyzedDefinition {
  definition: CardigannDefinition;
  supported: boolean;
  unsupportedReason?: string;
}
