import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { ExternalIds } from "@/server/parser/release-parser";
import { getLibraryItems, providerId, type JellyfinItem } from "@/server/jellyfin/jellyfin-client";
import { connectionFor, getAllLinks, getJellyfinUrl } from "@/server/jellyfin/jellyfin-service";

/**
 * Where a title on disk can tell us exactly what it is, before anything has to be
 * guessed from its name. Two sources, both authoritative when they answer:
 *
 *  - `.nfo` files beside the media. Jellyfin (with its NFO saver on), Kodi,
 *    Radarr and Sonarr write the provider ids they matched into them.
 *  - Jellyfin itself, when someone has linked an account: it has already
 *    identified every title in its libraries. Its paths are its own container's
 *    (`/data/movies/...` where media-box sees `/movies/...`), so items are
 *    matched by their file or folder NAME, which both sides share.
 */

/** What a hint is asked about: a movie (its folder and file) or a series folder. */
export type IdTarget = { kind: "movie" | "series"; folder: string; videoPath?: string };
export type IdHints = (target: IdTarget) => Promise<ExternalIds | null>;

function hasIds(ids: ExternalIds): boolean {
  return ids.tmdbId != null || ids.imdbId != null || ids.tvdbId != null;
}

const UNIQUE_ID_RE =
  /<uniqueid\b[^>]*\btype\s*=\s*["']?(tmdb|imdb|tvdb)["']?[^>]*>\s*([^<\s]+)\s*<\/uniqueid>/gi;
const LEGACY_TAG_RE = /<(tmdbid|imdbid|imdb_id|tvdbid)>\s*([^<\s]+)\s*<\/\1>/gi;
/** Kodi's old movie NFOs carry the IMDb id as a bare `<id>`. */
const BARE_IMDB_RE = /<id>\s*(tt\d+)\s*<\/id>/i;

/** Provider ids from an NFO document (Kodi / Jellyfin / *arr flavours). */
export function parseNfoIds(xml: string): ExternalIds {
  const ids: ExternalIds = {};
  const take = (provider: string, raw: string) => {
    const p = provider.toLowerCase();
    if (p.startsWith("imdb")) {
      if (/^tt\d+$/.test(raw) && !ids.imdbId) ids.imdbId = raw;
    } else if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n <= 0) return;
      if (p.startsWith("tmdb") && ids.tmdbId == null) ids.tmdbId = n;
      if (p.startsWith("tvdb") && ids.tvdbId == null) ids.tvdbId = n;
    }
  };
  for (const m of xml.matchAll(UNIQUE_ID_RE)) take(m[1], m[2]);
  for (const m of xml.matchAll(LEGACY_TAG_RE)) take(m[1], m[2]);
  const bare = BARE_IMDB_RE.exec(xml);
  if (bare) take("imdb", bare[1]);
  return ids;
}

/** The NFO files that would describe this target, most specific first. */
function nfoCandidates(target: IdTarget): string[] {
  if (target.kind === "series") return [path.join(target.folder, "tvshow.nfo")];
  const out: string[] = [];
  if (target.videoPath) {
    out.push(target.videoPath.slice(0, -path.extname(target.videoPath).length) + ".nfo");
  }
  out.push(path.join(target.folder, "movie.nfo"));
  return out;
}

export async function nfoIds(target: IdTarget): Promise<ExternalIds | null> {
  for (const file of nfoCandidates(target)) {
    let xml: string;
    try {
      xml = await fs.readFile(file, "utf8");
    } catch {
      continue; // no such NFO
    }
    const ids = parseNfoIds(xml);
    if (hasIds(ids)) return ids;
  }
  return null;
}

/** Name → ids, from what Jellyfin has identified. Names that collide are dropped. */
export class JellyfinIdIndex {
  private readonly byKey = new Map<string, ExternalIds | null>();

  constructor(items: JellyfinItem[]) {
    for (const item of items) {
      if (!item.Path) continue;
      const ids: ExternalIds = {};
      const tmdb = providerId(item, "Tmdb");
      const tvdb = providerId(item, "Tvdb");
      const imdb = providerId(item, "Imdb");
      if (tmdb && /^\d+$/.test(tmdb)) ids.tmdbId = Number(tmdb);
      if (tvdb && /^\d+$/.test(tvdb)) ids.tvdbId = Number(tvdb);
      if (imdb && /^tt\d+$/.test(imdb)) ids.imdbId = imdb;
      if (!hasIds(ids)) continue;
      // Jellyfin can run on Windows: split on either separator.
      const parts = item.Path.split(/[\\/]+/).filter(Boolean);
      const last = parts.at(-1);
      if (!last) continue;
      if (item.Type === "Movie") {
        this.add(`movie-file:${key(last)}`, ids);
        const folder = parts.at(-2);
        if (folder) this.add(`movie-dir:${key(folder)}`, ids);
      } else if (item.Type === "Series") {
        this.add(`series-dir:${key(last)}`, ids);
      }
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  lookup(target: IdTarget): ExternalIds | null {
    if (target.kind === "series")
      return this.byKey.get(`series-dir:${key(path.basename(target.folder))}`) ?? null;
    if (target.videoPath) {
      const byFile = this.byKey.get(`movie-file:${key(path.basename(target.videoPath))}`);
      if (byFile) return byFile;
    }
    return this.byKey.get(`movie-dir:${key(path.basename(target.folder))}`) ?? null;
  }

  private add(k: string, ids: ExternalIds) {
    const prior = this.byKey.get(k);
    if (prior === undefined) this.byKey.set(k, ids);
    // Two titles under one name (a shared category folder, two "Movies" dirs):
    // the name can't tell them apart, so it answers for neither.
    else if (prior && !sameIds(prior, ids)) this.byKey.set(k, null);
  }
}

function key(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function sameIds(a: ExternalIds, b: ExternalIds): boolean {
  return a.tmdbId === b.tmdbId && a.tvdbId === b.tvdbId && a.imdbId === b.imdbId;
}

/**
 * Jellyfin's view of the library, through the first linked account that answers
 * (admins first: they see every library). Null when no server is set up, nobody
 * has linked, or it can't be reached — the hints then come from NFOs alone.
 */
export async function loadJellyfinIndex(): Promise<JellyfinIdIndex | null> {
  const url = getJellyfinUrl();
  if (!url) return null;
  const db = getDb();
  const links = getAllLinks()
    .map((link) => {
      const user = db
        .select({ role: schema.users.role })
        .from(schema.users)
        .where(eq(schema.users.id, link.userId))
        .get();
      return { link, admin: user?.role === "admin" };
    })
    .sort((a, b) => Number(b.admin) - Number(a.admin));
  for (const { link } of links) {
    try {
      const res = await getLibraryItems(connectionFor(link, url));
      return new JellyfinIdIndex(res.Items ?? []);
    } catch {
      // That token may be stale; try the next account.
    }
  }
  return null;
}

/** NFO first (it sits with the file), then Jellyfin's identification. */
export function combineHints(jellyfin: JellyfinIdIndex | null): IdHints {
  return async (target) => (await nfoIds(target)) ?? jellyfin?.lookup(target) ?? null;
}

/** Hints from every source available right now. */
export async function buildIdHints(): Promise<IdHints> {
  return combineHints(await loadJellyfinIndex());
}
