import path from "node:path";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/server/db";
import { parseTitle } from "@/server/parser/release-parser";
import { searchMovie, searchTv, posterUrl, isAnimeMeta } from "@/server/metadata/tmdb";
import { aiEnabled } from "@/server/ai/llm";
import { aiResolveCandidate } from "@/server/ai/media-match";
import { recordLog } from "@/server/logging/logger";
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

/**
 * Rank suggestions so the entry matching the parsed title AND year comes first —
 * not just TMDB's top popularity hit. Critical when several releases share a name
 * (e.g. "Babygirl" 2013/2018/2022/2023/2024): the year from the filename is the
 * disambiguator. Ties keep TMDB's original (popularity) order.
 */
function suggestionScore(s: ImportSuggestion, query: string, yearHint: number | null): number {
  let score = 0;
  if (normalize(s.title) === normalize(query)) score += 2;
  if (yearHint != null && s.year != null) {
    const diff = Math.abs(yearHint - s.year);
    if (diff === 0) score += 4; // exact year → the strongest disambiguator
    else if (diff <= 1) score += 2; // ±1 tolerates release-date rounding
  }
  return score;
}

function rankSuggestions(
  list: ImportSuggestion[],
  query: string,
  yearHint: number | null
): ImportSuggestion[] {
  return list
    .map((s, i) => ({ s, i, score: suggestionScore(s, query, yearHint) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.s);
}

async function suggestFor(
  type: ImportType,
  query: string,
  yearHint: number | null = null
): Promise<ImportSuggestion[]> {
  try {
    let raw: ImportSuggestion[];
    if (type === "movie") {
      // Search broad (no year filter — that would exclude an off-by-one year);
      // the yearHint is applied in the ranking below with a ±1 tolerance.
      const res = await searchMovie(query);
      raw = res.results.map((r) => ({
        tmdbId: r.id,
        title: r.title,
        year: r.release_date ? Number(r.release_date.slice(0, 4)) || null : null,
        poster: posterUrl(r.poster_path),
        overview: r.overview ?? "",
      }));
    } else {
      // Series and anime both resolve against TMDB TV. For anime, keep only real
      // anime (Japanese-language Animation) so non-anime TV stops outranking the
      // actual show — e.g. "Bleach" was matching "Bleacher Report", and a Batman
      // cartoon could surface under an anime scan. Fall back to the full TV list
      // only when TMDB tagged none as anime, so a mistagged title stays matchable.
      const res = await searchTv(query);
      let results = res.results;
      if (type === "anime") {
        const anime = results.filter((r) => isAnimeMeta(r.genre_ids, r.original_language));
        if (anime.length > 0) results = anime;
      }
      raw = results.map((r) => ({
        tmdbId: r.id,
        title: r.name,
        year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) || null : null,
        poster: posterUrl(r.poster_path),
        overview: r.overview ?? "",
      }));
    }
    // Rank the FULL result set by title + year before trimming, so a matching-year
    // release that TMDB ranked low on popularity still surfaces (and is picked).
    return rankSuggestions(raw, query, yearHint).slice(0, 6);
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

// AI-assisted matching (optional; see Settings → General → AI assistant). Hard
// caps so a slow/broken model can only ever delay a scan, never hang or fail it.
const MAX_AI_CALLS_PER_SCAN = 25;
const AI_TIMEOUT_MS = 30_000;

/** Mutable per-scan AI-call allowance, shared by every candidate of the scan. */
interface AiBudget {
  remaining: number;
}

function newAiBudget(): AiBudget {
  return { remaining: aiEnabled() ? MAX_AI_CALLS_PER_SCAN : 0 };
}

/**
 * Best-effort AI pass over an "unsure" candidate: ask the model to pick one of
 * the existing suggestions (→ matched) or to extract a cleaner search query from
 * the raw name (→ retry TMDB once and adopt the result if it improves). Returns
 * null — leaving the candidate exactly as it was — when AI is off, the budget is
 * spent, the model fails, or its answer doesn't improve anything. Never throws.
 */
async function aiRefineCandidate(
  type: ImportType,
  rawName: string,
  parsedTitle: string,
  parsedYear: number | null,
  suggestions: ImportSuggestion[],
  excludeTmdb: Set<number>,
  budget: AiBudget
): Promise<{
  status: "matched" | "unsure";
  suggestedTmdbId: number | null;
  suggestions: ImportSuggestion[];
} | null> {
  if (budget.remaining <= 0) return null;
  budget.remaining -= 1;
  try {
    const res = await aiResolveCandidate(
      {
        type,
        fileName: rawName,
        parsedTitle,
        parsedYear,
        suggestions: suggestions.map((s) => ({ tmdbId: s.tmdbId, title: s.title, year: s.year })),
      },
      { timeoutMs: AI_TIMEOUT_MS }
    );
    // The model picked one of the offered suggestions → confident match.
    if (res.tmdbId != null && suggestions.some((s) => s.tmdbId === res.tmdbId)) {
      return { status: "matched", suggestedTmdbId: res.tmdbId, suggestions };
    }
    // The model extracted a cleaner query → retry TMDB once with it.
    if (res.searchQuery) {
      const retried = (await suggestFor(type, res.searchQuery, res.year)).filter(
        (s) => !excludeTmdb.has(s.tmdbId)
      );
      const reclassified = classify(retried, res.searchQuery, res.year);
      // Adopt only when the retry improves on the original: a confident match,
      // or at least some suggestions where there were none before.
      if (
        reclassified.status === "matched" ||
        (suggestions.length === 0 && retried.length > 0)
      ) {
        return { ...reclassified, suggestions: retried };
      }
    }
  } catch (err) {
    recordLog(
      "warn",
      `AI-assisted match failed for "${rawName}": ${err instanceof Error ? err.message : String(err)}`,
      { source: "ai" }
    );
  }
  return null;
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
  // Also index registered files by basename+size so an already-imported file is
  // skipped even when the movie's stored path doesn't line up byte-for-byte with
  // where we walk it (migrated paths, Unraid /mnt/user vs cache/disk, symlinks) —
  // which otherwise makes a just-imported title reappear as "needs review".
  const existingSignatures = new Set<string>();
  for (const mf of db
    .select({
      movieId: schema.movieFiles.movieId,
      relativePath: schema.movieFiles.relativePath,
      size: schema.movieFiles.size,
    })
    .from(schema.movieFiles)
    .all()) {
    const m = movieById.get(mf.movieId);
    if (m) existingFilePaths.add(path.join(m.path, mf.relativePath));
    existingSignatures.add(`${path.basename(mf.relativePath)}|${mf.size}`);
  }

  // Cross-type guard: skip files living inside an imported SERIES/anime folder.
  // If a series directory is (mis)scanned as movies, every episode file would
  // otherwise surface as a bogus movie candidate.
  const seriesPrefixes = db
    .select({ path: schema.series.path })
    .from(schema.series)
    .all()
    .map((s) => path.resolve(s.path) + path.sep);

  interface Agg {
    title: string;
    year: number | null;
    best: { absPath: string; size: number };
    count: number;
  }
  const byKey = new Map<string, Agg>();

  for (const file of files) {
    if (
      existingFilePaths.has(file.absPath) ||
      existingSignatures.has(`${path.basename(file.absPath)}|${file.size}`)
    ) {
      continue;
    }
    const resolved = path.resolve(file.absPath);
    if (seriesPrefixes.some((p) => resolved.startsWith(p))) continue;

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

  const aiBudget = newAiBudget();
  const candidates: ImportCandidate[] = [];
  for (const agg of limited) {
    let suggestions = (await suggestFor("movie", agg.title, agg.year)).filter(
      (s) => !existingTmdb.has(s.tmdbId)
    );
    let { status, suggestedTmdbId } = classify(suggestions, agg.title, agg.year);
    const videoPath = agg.best.absPath;
    if (status === "unsure") {
      const refined = await aiRefineCandidate(
        "movie",
        path.basename(videoPath),
        agg.title,
        agg.year,
        suggestions,
        existingTmdb,
        aiBudget
      );
      if (refined) ({ status, suggestedTmdbId, suggestions } = refined);
    }
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
  // Cross-type guard: also skip folders that belong to imported MOVIES. If a
  // movies directory is (mis)scanned as series/anime — e.g. a root folder
  // registered under the wrong media type — each movie folder would otherwise
  // surface here as a bogus series candidate.
  for (const m of db.select({ path: schema.movies.path }).from(schema.movies).all()) {
    existingPaths.add(m.path);
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const aiBudget = newAiBudget();
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

    let suggestions = (await suggestFor(type, query, yearHint)).filter(
      (s) => !existingTmdb.has(s.tmdbId)
    );
    let { status, suggestedTmdbId } = classify(suggestions, query, yearHint);
    if (status === "unsure") {
      const refined = await aiRefineCandidate(
        type,
        d.name,
        query,
        yearHint,
        suggestions,
        existingTmdb,
        aiBudget
      );
      if (refined) ({ status, suggestedTmdbId, suggestions } = refined);
    }

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
