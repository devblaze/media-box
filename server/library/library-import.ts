import path from "node:path";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/server/db";
import { parseTitle } from "@/server/parser/release-parser";
import { searchMovie, searchTv, posterUrl } from "@/server/metadata/tmdb";
import { walkVideoFiles } from "./disk-scanner";

export type ImportType = "movie" | "series" | "anime";

export interface ImportSuggestion {
  tmdbId: number;
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
}

export interface ImportCandidate {
  /** Absolute path of the folder that should become movie.path / series.path. */
  path: string;
  /**
   * Absolute path of the representative video file (movies only — the largest file
   * when several map to one title). Empty for folder-based series/anime candidates.
   */
  videoPath: string;
  /** Display name (video file basename for movies, folder name for series/anime). */
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

export interface ScanResult {
  candidates: ImportCandidate[];
  /** True when there were more titles on disk than the per-scan cap. */
  truncated: boolean;
}

/** Cap TMDB lookups per scan so a huge library can't hang the request. */
const MAX_CANDIDATES = 150;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Filenames/folders that carry no usable title (disc parts, placeholders, digits-only). */
const GENERIC_TITLE = /^(movie|video|film|feature|cd|disc|dvd|part|title|vts|track)[\s._-]?\d*$/i;

function isUsableTitle(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2) return false;
  const compact = t.replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) return false; // digits only
  if (GENERIC_TITLE.test(compact)) return false;
  return true;
}

/**
 * The release-parser can leave a trailing space/dot-separated year in the title
 * (e.g. a plain folder "Inception 2010"). Strip it so the TMDB query is the bare
 * title, and use it as the year hint when none was found.
 */
function stripTrailingYear(title: string, yearHint: number | null): { title: string; year: number | null } {
  const trailing = title.match(/^(.*?)[\s.]+((?:19|20)\d{2})\s*$/);
  if (trailing) {
    return { title: trailing[1].trim(), year: yearHint ?? Number(trailing[2]) };
  }
  return { title, year: yearHint };
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
    // series and anime both resolve against TMDB TV.
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

/** Decide whether the top suggestion is a confident match for the parsed title/year. */
function classify(
  suggestions: ImportSuggestion[],
  query: string,
  yearHint: number | null
): { status: "matched" | "unsure"; suggestedTmdbId: number | null } {
  if (suggestions.length === 0) return { status: "unsure", suggestedTmdbId: null };
  const top = suggestions[0];
  const titleMatch = normalize(top.title) === normalize(query);
  const yearMatch = yearHint != null && top.year != null && Math.abs(yearHint - top.year) <= 1;
  // Confident when the title matches and either the year agrees or there was no year to check,
  // or there is exactly one plausible result with a matching title.
  if ((titleMatch && (yearHint == null || yearMatch)) || (suggestions.length === 1 && titleMatch)) {
    return { status: "matched", suggestedTmdbId: top.tmdbId };
  }
  return { status: "unsure", suggestedTmdbId: null };
}

/**
 * Movies: recurse the whole tree and produce one candidate per movie FILE (not per
 * top-level folder). Files that share a normalized title+year — multiple parts,
 * extras, or a dedicated movie folder — collapse into a single candidate whose
 * representative is the largest file.
 */
async function scanMoviesByFile(db: Db, root: string): Promise<ScanResult> {
  const files = await walkVideoFiles(root);

  // Skip files already registered to a movie, and don't suggest tmdbIds already in the library.
  const existingFilePaths = new Set<string>();
  const existingTmdb = new Set<number>();
  const movieById = new Map<number, { path: string }>();
  for (const m of db
    .select({ id: schema.movies.id, path: schema.movies.path, tmdbId: schema.movies.tmdbId })
    .from(schema.movies)
    .all()) {
    movieById.set(m.id, { path: m.path });
    existingTmdb.add(m.tmdbId);
  }
  for (const mf of db
    .select({ movieId: schema.movieFiles.movieId, relativePath: schema.movieFiles.relativePath })
    .from(schema.movieFiles)
    .all()) {
    const m = movieById.get(mf.movieId);
    if (m) existingFilePaths.add(path.join(m.path, mf.relativePath));
  }

  interface Agg {
    title: string;
    year: number | null;
    best: { absPath: string; size: number };
    count: number;
  }
  const byKey = new Map<string, Agg>();

  for (const file of files) {
    if (existingFilePaths.has(file.absPath)) continue;

    const fromFile = parseTitle(path.basename(file.absPath));
    let title = fromFile.title;
    let year: number | null = fromFile.year ?? null;

    // If the filename yields no usable title, fall back to the parent folder name.
    if (!isUsableTitle(title)) {
      const parentName = path.basename(path.dirname(file.absPath));
      const fromFolder = parseTitle(parentName);
      title = fromFolder.title || parentName;
      year = fromFolder.year ?? null;
    }
    ({ title, year } = stripTrailingYear(title, year));
    // Only bail when there is genuinely no title left (e.g. a year-only name). A short
    // real title like "A"/"B"/"M" or "It" is kept — we've already used the best source.
    if (title.trim().length === 0) continue;

    const key = `${normalize(title)}|${year ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (file.size > existing.best.size) existing.best = file; // keep the largest as representative
    } else {
      byKey.set(key, { title, year, best: file, count: 1 });
    }
  }

  const aggs = [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title));
  const truncated = aggs.length > MAX_CANDIDATES;
  const limited = aggs.slice(0, MAX_CANDIDATES);

  const candidates: ImportCandidate[] = [];
  for (const agg of limited) {
    const suggestions = (await suggestFor("movie", agg.title)).filter((s) => !existingTmdb.has(s.tmdbId));
    const { status, suggestedTmdbId } = classify(suggestions, agg.title, agg.year);
    const videoPath = agg.best.absPath;
    candidates.push({
      path: path.dirname(videoPath), // loose file → its category folder; dedicated folder → that folder
      videoPath,
      name: path.basename(videoPath),
      parsedTitle: agg.title,
      parsedYear: agg.year,
      videoFileCount: agg.count,
      status,
      suggestedTmdbId,
      suggestions,
    });
  }
  return { candidates, truncated };
}

/**
 * Series / anime: each immediate subfolder of the root is one title. Parse the
 * folder name, match against TMDB TV, classify.
 */
async function scanFolders(db: Db, type: ImportType, root: string): Promise<ScanResult> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { candidates: [], truncated: false };
  }

  // Series (incl. anime) are stored in the series table — skip their folders + tmdbIds.
  const existingPaths = new Set<string>();
  const existingTmdb = new Set<number>();
  for (const r of db
    .select({ path: schema.series.path, tmdbId: schema.series.tmdbId })
    .from(schema.series)
    .all()) {
    existingPaths.add(r.path);
    existingTmdb.add(r.tmdbId);
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const candidates: ImportCandidate[] = [];
  let truncated = false;
  for (const d of dirs) {
    if (candidates.length >= MAX_CANDIDATES) {
      truncated = true;
      break;
    }
    if (existingPaths.has(d.path)) continue; // already imported

    const videos = await walkVideoFiles(d.path);
    if (videos.length === 0) continue; // no playable media in this folder

    const parsed = parseTitle(d.name);
    let query = parsed.title || d.name;
    let yearHint = parsed.year ?? null;
    ({ title: query, year: yearHint } = stripTrailingYear(query, yearHint));

    const suggestions = (await suggestFor(type, query)).filter((s) => !existingTmdb.has(s.tmdbId));
    const { status, suggestedTmdbId } = classify(suggestions, query, yearHint);

    candidates.push({
      path: d.path,
      videoPath: "",
      name: d.name,
      parsedTitle: query,
      parsedYear: yearHint,
      videoFileCount: videos.length,
      status,
      suggestedTmdbId,
      suggestions,
    });
  }

  return { candidates, truncated };
}

/**
 * Scan a library root folder for on-disk titles not yet in the library, match each
 * against TMDB, and classify as a confident match or "unsure" (needs manual pick).
 *
 * Movies produce one candidate per movie FILE (recursing category folders); series
 * and anime produce one candidate per immediate subfolder.
 */
export async function scanLibrary(type: ImportType, root: string): Promise<ScanResult> {
  const db = getDb();
  if (type === "movie") return scanMoviesByFile(db, root);
  return scanFolders(db, type, root);
}

/** A stored candidate carries the root folder / quality profile the scan ran with. */
export interface StoredCandidate extends ImportCandidate {
  rootFolderId: number | null;
  qualityProfileId: number | null;
}

/**
 * Persist a fresh scan for a type: replace every prior row of that type with the
 * new candidates so the unmatched list survives navigation without rescanning.
 * The `rootFolderId` / `qualityProfileId` the scan ran with are stored per row so
 * the background batch import can reproduce the same import as the single-import UI.
 */
export function persistScanCandidates(
  type: ImportType,
  rootFolderId: number,
  qualityProfileId: number | null,
  candidates: ImportCandidate[]
): void {
  const db = getDb();
  db.delete(schema.scanCandidates).where(eq(schema.scanCandidates.type, type)).run();
  if (candidates.length === 0) return;
  const now = new Date();
  db.insert(schema.scanCandidates)
    .values(
      candidates.map((c) => ({
        type,
        rootFolderId,
        qualityProfileId,
        path: c.path,
        videoPath: c.videoPath || null,
        name: c.name,
        parsedTitle: c.parsedTitle,
        parsedYear: c.parsedYear,
        status: c.status,
        suggestedTmdbId: c.suggestedTmdbId,
        suggestions: c.suggestions,
        imported: false,
        createdAt: now,
      }))
    )
    .run();
}

/**
 * Mark a persisted candidate as imported so it drops off the reloaded list. Used
 * by the single-import route (manual per-title imports of "unsure" rows) so those
 * stay dropped after navigation, mirroring what the batch import does for matches.
 * A no-op when there is no matching persisted candidate.
 */
export function markCandidateImported(type: ImportType, path: string): void {
  const db = getDb();
  db.update(schema.scanCandidates)
    .set({ imported: true, error: null })
    .where(and(eq(schema.scanCandidates.type, type), eq(schema.scanCandidates.path, path)))
    .run();
}

/** The not-yet-imported candidates of a type, so the page can reload a prior scan. */
export function loadScanCandidates(type: ImportType): StoredCandidate[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.scanCandidates)
    .where(and(eq(schema.scanCandidates.type, type), eq(schema.scanCandidates.imported, false)))
    .all();
  return rows.map((r) => ({
    path: r.path,
    videoPath: r.videoPath ?? "",
    name: r.name,
    parsedTitle: r.parsedTitle,
    parsedYear: r.parsedYear,
    // videoFileCount is not persisted; every candidate had at least one file.
    videoFileCount: 1,
    status: r.status,
    suggestedTmdbId: r.suggestedTmdbId,
    suggestions: (r.suggestions as ImportSuggestion[] | null) ?? [],
    rootFolderId: r.rootFolderId,
    qualityProfileId: r.qualityProfileId,
  }));
}
