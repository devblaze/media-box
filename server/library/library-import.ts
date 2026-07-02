import path from "node:path";
import fs from "node:fs/promises";
import { getDb, schema } from "@/server/db";
import { parseTitle } from "@/server/parser/release-parser";
import { searchMovie, searchTv, posterUrl } from "@/server/metadata/tmdb";
import { walkVideoFiles } from "./disk-scanner";

export type ImportType = "movie" | "series";

export interface ImportSuggestion {
  tmdbId: number;
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
}

export interface ImportCandidate {
  /** Absolute path of the on-disk folder. */
  path: string;
  /** Folder name (display). */
  name: string;
  parsedTitle: string;
  parsedYear: number | null;
  videoFileCount: number;
  /**
   * "matched"  — a confident TMDB match (suggestedTmdbId set); can be imported directly.
   * "unsure"   — ambiguous / low confidence; needs the admin to pick from suggestions or search.
   */
  status: "matched" | "unsure";
  suggestedTmdbId: number | null;
  suggestions: ImportSuggestion[];
}

/** Cap TMDB lookups per scan so a huge library can't hang the request. */
const MAX_CANDIDATES = 100;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function suggestFor(type: ImportType, query: string): Promise<ImportSuggestion[]> {
  try {
    if (type === "movie") {
      const res = await searchMovie(query);
      return res.results.slice(0, 6).map((r) => ({
        tmdbId: r.id,
        title: r.title,
        year: r.release_date ? Number(r.release_date.slice(0, 4)) || null : null,
        poster: posterUrl(r.poster_path),
        overview: r.overview ?? "",
      }));
    }
    const res = await searchTv(query);
    return res.results.slice(0, 6).map((r) => ({
      tmdbId: r.id,
      title: r.name,
      year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) || null : null,
      poster: posterUrl(r.poster_path),
      overview: r.overview ?? "",
    }));
  } catch {
    return [];
  }
}

/**
 * Scan a library root folder for on-disk titles not yet in the library, parse
 * each folder name, and match it against TMDB. Returns a candidate per folder,
 * classified as a confident match or "unsure" (needs manual selection).
 */
export async function scanLibrary(type: ImportType, root: string): Promise<ImportCandidate[]> {
  const db = getDb();

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  // Titles already in the library — skip their folders + don't suggest their tmdbIds.
  const existingPaths = new Set<string>();
  const existingTmdb = new Set<number>();
  if (type === "movie") {
    for (const r of db
      .select({ path: schema.movies.path, tmdbId: schema.movies.tmdbId })
      .from(schema.movies)
      .all()) {
      existingPaths.add(r.path);
      existingTmdb.add(r.tmdbId);
    }
  } else {
    for (const r of db
      .select({ path: schema.series.path, tmdbId: schema.series.tmdbId })
      .from(schema.series)
      .all()) {
      existingPaths.add(r.path);
      existingTmdb.add(r.tmdbId);
    }
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const candidates: ImportCandidate[] = [];
  for (const d of dirs) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (existingPaths.has(d.path)) continue; // already imported

    const videos = await walkVideoFiles(d.path);
    if (videos.length === 0) continue; // no playable media in this folder

    const parsed = parseTitle(d.name);
    let query = parsed.title || d.name;
    let yearHint = parsed.year ?? null;
    // The release-parser can leave a trailing space-separated year in the title
    // (e.g. a plain folder "Inception 2010"). Strip it so the TMDB query is the bare
    // title, and use it as the year hint when the parser found none.
    const trailing = query.match(/^(.*?)[\s.]+((?:19|20)\d{2})\s*$/);
    if (trailing) {
      query = trailing[1].trim();
      if (yearHint == null) yearHint = Number(trailing[2]);
    }

    const suggestions = (await suggestFor(type, query)).filter((s) => !existingTmdb.has(s.tmdbId));

    let status: "matched" | "unsure" = "unsure";
    let suggestedTmdbId: number | null = null;
    if (suggestions.length > 0) {
      const top = suggestions[0];
      const titleMatch = normalize(top.title) === normalize(query);
      const yearMatch = yearHint != null && top.year != null && Math.abs(yearHint - top.year) <= 1;
      // Confident when the title matches and either the year agrees or there was no year to check,
      // or there is exactly one plausible result with a matching title.
      if ((titleMatch && (yearHint == null || yearMatch)) || (suggestions.length === 1 && titleMatch)) {
        status = "matched";
        suggestedTmdbId = top.tmdbId;
      }
    }

    candidates.push({
      path: d.path,
      name: d.name,
      parsedTitle: query,
      parsedYear: yearHint,
      videoFileCount: videos.length,
      status,
      suggestedTmdbId,
      suggestions,
    });
  }

  return candidates;
}
