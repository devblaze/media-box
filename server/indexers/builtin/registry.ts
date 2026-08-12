import { apibay } from "./apibay";
import { nyaa } from "./nyaa";
import { yts } from "./yts";
import { eztv } from "./eztv";
import type { BuiltinDef } from "./types";

/** All built-in indexers, keyed by their `definition` value. */
const BUILTINS: Record<string, BuiltinDef> = {
  [apibay.key]: apibay,
  [nyaa.key]: nyaa,
  [yts.key]: yts,
  [eztv.key]: eztv,
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

/**
 * Loose name/slug aliases used to match a Jackett/Torznab feed to its built-in
 * equivalent (the "migrate off Jackett" flow). Jackett names indexers like
 * "The Pirate Bay" and its Torznab URL carries a slug like `.../indexers/thepiratebay/`.
 */
const ALIASES: Record<string, string[]> = {
  apibay: ["the pirate bay", "thepiratebay", "pirate bay", "piratebay", "tpb", "apibay"],
  nyaa: ["nyaa", "nyaa si", "nyaasi"],
  yts: ["yts", "yify", "yts mx", "yts ag", "yts am"],
  eztv: ["eztv", "eztvx", "eztv re", "eztv it"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Match a Torznab indexer's name (or its Jackett URL slug/host) to a built-in
 * key. Returns null when nothing matches confidently. Deliberately loose — the
 * migrate flow shows a preview the user confirms, so a stray match is caught
 * there; the 4-char floor on substring matching keeps short aliases (e.g. "tpb")
 * to exact matches only.
 */
export function findBuiltinKeyByName(nameOrSlug: string): string | null {
  const n = norm(nameOrSlug);
  if (!n) return null;
  for (const b of Object.values(BUILTINS)) {
    const candidates = [norm(b.name), norm(b.key), ...(ALIASES[b.key] ?? []).map(norm)];
    if (
      candidates.some(
        (c) =>
          c &&
          (n === c ||
            (c.length >= 4 && n.includes(c)) ||
            (n.length >= 4 && c.includes(n)))
      )
    ) {
      return b.key;
    }
  }
  return null;
}

export type { BuiltinDef };
