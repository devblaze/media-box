import { apibay } from "./apibay";
import { nyaa } from "./nyaa";
import type { BuiltinDef } from "./types";

/** All built-in indexers, keyed by their `definition` value. */
const BUILTINS: Record<string, BuiltinDef> = {
  [apibay.key]: apibay,
  [nyaa.key]: nyaa,
};

export function getBuiltin(key: string | null | undefined): BuiltinDef | undefined {
  return key ? BUILTINS[key] : undefined;
}

/** Public metadata for the "add built-in indexer" picker (no `search` fn). */
export function listBuiltins(): Omit<BuiltinDef, "search">[] {
  return Object.values(BUILTINS).map((b) => ({
    key: b.key,
    name: b.name,
    description: b.description,
    site: b.site,
    supportsTv: b.supportsTv,
    supportsMovies: b.supportsMovies,
    categories: b.categories,
  }));
}

export type { BuiltinDef };
