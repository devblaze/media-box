import path from "node:path";
import fs from "node:fs/promises";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { QualityModel } from "@/server/parser/quality";
import { parseTitle } from "@/server/parser/release-parser";
import { renderEpisodeFilename, renderMovieFilename, renderSeasonFolder } from "./naming";
import { applyOwnership, freeSpace, mkdirp, placeFile, removeMedia } from "./filesystem";
import { probeMediaInfo } from "./media-info";
import { walkVideoFiles } from "./disk-scanner";
import { emitEvent } from "@/server/events/bus";
import { markRequestsAvailable } from "@/server/requests/request-service";
import { getSettings } from "@/server/settings/settings-service";

// ---------- types ----------

export type OrganizeItemType = "movie" | "episode" | "unknown";
export type OrganizeMatchKind = "series" | "anime" | "movie" | "none";
export type OrganizeAction = "hardlink" | "copy" | "move";

export interface OrganizeMatch {
  kind: OrganizeMatchKind;
  id: number | null;
  title: string | null;
  /** Resolved episode ids (episodes only); empty otherwise. */
  episodeIds: number[];
}

export interface OrganizeItem {
  sourcePath: string;
  name: string;
  size: number;
  type: OrganizeItemType;
  parsedTitle: string;
  year: number | null;
  season: number | null;
  episodes: number[];
  match: OrganizeMatch;
  /** True when this exact source path was already organized (logged) before. */
  alreadyOrganized: boolean;
}

export interface OrganizeTarget {
  kind: "series" | "anime" | "movie";
  id: number;
  seasonNumber?: number;
  episodeNumbers?: number[];
}

export interface OrganizeResult {
  status: "organized";
  sourcePath: string;
  destPath: string;
  action: OrganizeAction;
  mediaType: "movie" | "series" | "anime";
  title: string;
  detail: string | null;
}

export interface OrganizeLogFilter {
  q?: string;
  type?: "movie" | "series" | "anime";
  status?: "organized" | "failed" | "skipped";
  limit?: number;
}

const LOG_DEFAULT_LIMIT = 200;
const LOG_MAX_LIMIT = 1000;

/** Lowercase + strip every non-alphanumeric character (spaces, punctuation…). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "S01E03" or "S01E03E04" for a set of episode numbers in a season. */
function episodeDetail(season: number, episodes: number[]): string {
  const eps = [...episodes].sort((a, b) => a - b);
  return `S${pad2(season)}${eps.map((e) => `E${pad2(e)}`).join("")}`;
}

function getNaming() {
  const row = getDb().select().from(schema.namingConfig).get();
  if (!row) throw new Error("Naming config missing");
  return row;
}

// ---------- scan + match ----------

/**
 * Walk the configured downloads folder for loose video files and, for each,
 * parse the release name, classify it (movie / episode / unknown), and try to
 * match it to an existing library title. Non-destructive: reads only.
 */
export async function scanDownloads(): Promise<OrganizeItem[]> {
  const settings = getSettings();
  const root = settings.downloadsPath;
  if (!root) return [];

  const files = await walkVideoFiles(root);
  if (files.length === 0) return [];

  const db = getDb();
  const allSeries = db
    .select({
      id: schema.series.id,
      title: schema.series.title,
      isAnime: schema.series.isAnime,
    })
    .from(schema.series)
    .all();
  const allMovies = db
    .select({ id: schema.movies.id, title: schema.movies.title, year: schema.movies.year })
    .from(schema.movies)
    .all();

  // Precompute normalized library titles once.
  const seriesNorm = allSeries.map((s) => ({ ...s, norm: normalize(s.title) }));
  const moviesNorm = allMovies.map((m) => ({ ...m, norm: normalize(m.title) }));

  // Source paths already organized (dim those rows in the UI).
  const organized = new Set(
    db
      .select({ sourcePath: schema.organizeLog.sourcePath })
      .from(schema.organizeLog)
      .where(eq(schema.organizeLog.status, "organized"))
      .all()
      .map((r) => r.sourcePath)
  );

  const items: OrganizeItem[] = [];
  for (const file of files) {
    const name = path.basename(file.absPath);
    const parsed = parseTitle(name);
    const parsedNorm = normalize(parsed.title);

    let type: OrganizeItemType;
    if (parsed.isTv && parsed.episodes.length > 0) type = "episode";
    else if (!parsed.isTv) type = "movie";
    else type = "unknown"; // season pack / ambiguous TV without episode numbers

    let match: OrganizeMatch = { kind: "none", id: null, title: null, episodeIds: [] };

    if (type === "episode" && parsedNorm) {
      const hit =
        seriesNorm.find((s) => s.norm === parsedNorm) ??
        // fallback: a library title that contains the parsed title
        seriesNorm.find((s) => parsedNorm.length >= 3 && s.norm.includes(parsedNorm));
      if (hit) {
        const seasonNumber = parsed.seasons[0];
        const episodeRows = db
          .select({ id: schema.episodes.id })
          .from(schema.episodes)
          .where(
            and(
              eq(schema.episodes.seriesId, hit.id),
              eq(schema.episodes.seasonNumber, seasonNumber),
              inArray(schema.episodes.episodeNumber, parsed.episodes)
            )
          )
          .all();
        match = {
          kind: hit.isAnime ? "anime" : "series",
          id: hit.id,
          title: hit.title,
          episodeIds: episodeRows.map((e) => e.id),
        };
      }
    } else if (type === "movie" && parsedNorm) {
      const exact = moviesNorm.filter((m) => m.norm === parsedNorm);
      const hit =
        (parsed.year ? exact.find((m) => m.year === parsed.year) : undefined) ??
        exact[0] ??
        (parsedNorm.length >= 3
          ? moviesNorm.find((m) => m.norm.includes(parsedNorm))
          : undefined);
      if (hit) {
        match = { kind: "movie", id: hit.id, title: hit.title, episodeIds: [] };
      }
    }

    items.push({
      sourcePath: file.absPath,
      name,
      size: file.size,
      type,
      parsedTitle: parsed.title,
      year: parsed.year ?? null,
      season: parsed.seasons[0] ?? null,
      episodes: parsed.episodes,
      match,
      alreadyOrganized: organized.has(file.absPath),
    });
  }

  return items;
}

// ---------- organize (mirrors the importer) ----------

/**
 * Organize a single loose file into the library at an explicit target. Mirrors
 * `importer.ts`: render the destination from `namingConfig`, `placeFile` (auto =
 * hardlink same-fs else copy — non-destructive), register the file row, link the
 * episode(s) / set the movie file, emit an update event, and record a log row.
 * Non-destructive by default; only importMode "move" removes the source.
 */
export async function organizeFile(
  sourcePath: string,
  target: OrganizeTarget
): Promise<OrganizeResult> {
  const db = getDb();
  const logMediaType = target.kind; // "series" | "anime" | "movie" — matches organize_log enum
  try {
    const settings = getSettings();
    const mode = settings.importMode;
    const naming = getNaming();
    const name = path.basename(sourcePath);
    const ext = path.extname(sourcePath);
    const sceneName = path.basename(sourcePath, ext);
    const parsed = parseTitle(name);

    // Stat the source BEFORE placing — a "move" removes it afterwards.
    const srcStat = await fs.stat(sourcePath).catch(() => null);
    if (!srcStat) throw new Error(`Source file not found: ${sourcePath}`);
    const size = srcStat.size;

    if (target.kind === "movie") {
      const m = db.select().from(schema.movies).where(eq(schema.movies.id, target.id)).get();
      if (!m) throw new Error("Movie is not in the library");

      const quality: QualityModel = parsed.quality;
      const filename = renderMovieFilename(
        naming.movieFormat,
        {
          movieTitle: m.title,
          movieYear: m.year,
          quality,
          releaseGroup: parsed.releaseGroup,
        },
        { replaceIllegal: naming.replaceIllegalCharacters }
      );
      const dest = path.join(m.path, filename + ext);

      const createdDirs = await mkdirp(m.path);
      if ((await freeSpace(m.path)) < size + 100 * 1024 * 1024) {
        throw new Error("Not enough free space at destination");
      }
      const { method } = await placeFile(sourcePath, dest, mode);
      await applyOwnership(dest, createdDirs);
      const mediaInfo = await probeMediaInfo(dest);

      const oldFileId = m.movieFileId;
      const fileRow = db
        .insert(schema.movieFiles)
        .values({
          movieId: m.id,
          relativePath: path.relative(m.path, dest),
          size,
          quality,
          releaseGroup: parsed.releaseGroup ?? null,
          sceneName,
          dateAdded: new Date(),
          mediaInfo,
        })
        .returning({ id: schema.movieFiles.id })
        .get();
      db.update(schema.movies)
        .set({ movieFileId: fileRow.id })
        .where(eq(schema.movies.id, m.id))
        .run();

      // Delete a replaced file only after its successor is registered.
      if (oldFileId && oldFileId !== fileRow.id) {
        const old = db
          .select()
          .from(schema.movieFiles)
          .where(eq(schema.movieFiles.id, oldFileId))
          .get();
        if (old) {
          const oldPath = path.join(m.path, old.relativePath);
          if (path.resolve(oldPath) !== path.resolve(dest)) {
            await removeMedia(oldPath);
          }
          db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, oldFileId)).run();
        }
      }

      db.insert(schema.history)
        .values({
          eventType: "imported",
          mediaType: "movie",
          movieId: m.id,
          sourceTitle: name,
          quality,
          data: { importMethod: method, path: dest, source: "organizer" },
          date: new Date(),
        })
        .run();
      emitEvent({ type: "movie.updated", movieId: m.id });
      markRequestsAvailable("movie", m.id);
      emitEvent({ type: "history.added" });

      const detail = m.year ? String(m.year) : parsed.year ? String(parsed.year) : null;
      db.insert(schema.organizeLog)
        .values({
          sourcePath,
          destPath: dest,
          mediaType: "movie",
          title: m.title,
          detail,
          action: method,
          status: "organized",
          message: null,
          createdAt: new Date(),
        })
        .run();

      return {
        status: "organized",
        sourcePath,
        destPath: dest,
        action: method,
        mediaType: "movie",
        title: m.title,
        detail,
      };
    }

    // --- series / anime episode ---
    const s = db.select().from(schema.series).where(eq(schema.series.id, target.id)).get();
    if (!s) throw new Error("Series is not in the library");

    const seasonNumber = target.seasonNumber ?? parsed.seasons[0];
    if (seasonNumber == null) throw new Error("Season number is required for an episode");
    const episodeNumbers =
      target.episodeNumbers && target.episodeNumbers.length > 0
        ? target.episodeNumbers
        : parsed.episodes;
    if (episodeNumbers.length === 0) throw new Error("Episode number(s) required");

    const episodeRows = db
      .select()
      .from(schema.episodes)
      .where(
        and(
          eq(schema.episodes.seriesId, s.id),
          eq(schema.episodes.seasonNumber, seasonNumber),
          inArray(schema.episodes.episodeNumber, episodeNumbers)
        )
      )
      .all();
    if (episodeRows.length === 0) {
      throw new Error(`No matching episodes for S${pad2(seasonNumber)} in '${s.title}'`);
    }

    const quality: QualityModel = parsed.quality;
    const sortedEpisodeNumbers = episodeRows.map((e) => e.episodeNumber).sort((a, b) => a - b);
    const seasonFolder = s.seasonFolder
      ? renderSeasonFolder(naming.seasonFolderFormat, seasonNumber)
      : "";
    // renameEpisodes=false keeps the original release file name; otherwise render.
    const filename = naming.renameEpisodes
      ? renderEpisodeFilename(
          naming.standardEpisodeFormat,
          {
            seriesTitle: s.title,
            seriesYear: s.year,
            seasonNumber,
            episodeNumbers: sortedEpisodeNumbers,
            episodeTitle: episodeRows[0].title,
            quality,
            releaseGroup: parsed.releaseGroup,
          },
          { replaceIllegal: naming.replaceIllegalCharacters }
        )
      : sceneName;
    const destDir = path.join(s.path, seasonFolder);
    const dest = path.join(destDir, filename + ext);

    const createdDirs = await mkdirp(destDir);
    if ((await freeSpace(destDir)) < size + 100 * 1024 * 1024) {
      throw new Error("Not enough free space at destination");
    }
    const { method } = await placeFile(sourcePath, dest, mode);
    await applyOwnership(dest, createdDirs);
    const mediaInfo = await probeMediaInfo(dest);

    const fileRow = db
      .insert(schema.episodeFiles)
      .values({
        seriesId: s.id,
        relativePath: path.relative(s.path, dest),
        size,
        quality,
        releaseGroup: parsed.releaseGroup ?? null,
        sceneName,
        dateAdded: new Date(),
        mediaInfo,
      })
      .returning({ id: schema.episodeFiles.id })
      .get();

    for (const ep of episodeRows) {
      // Delete a replaced file only after its successor is in place.
      if (ep.episodeFileId && ep.episodeFileId !== fileRow.id) {
        const old = db
          .select()
          .from(schema.episodeFiles)
          .where(eq(schema.episodeFiles.id, ep.episodeFileId))
          .get();
        if (old) {
          const oldPath = path.join(s.path, old.relativePath);
          if (path.resolve(oldPath) !== path.resolve(dest)) {
            await removeMedia(oldPath);
          }
          db.delete(schema.episodeFiles).where(eq(schema.episodeFiles.id, old.id)).run();
        }
      }
      db.update(schema.episodes)
        .set({ episodeFileId: fileRow.id })
        .where(eq(schema.episodes.id, ep.id))
        .run();

      db.insert(schema.history)
        .values({
          eventType: "imported",
          mediaType: "series",
          seriesId: s.id,
          episodeId: ep.id,
          sourceTitle: name,
          quality,
          data: { importMethod: method, path: dest, source: "organizer" },
          date: new Date(),
        })
        .run();
    }
    emitEvent({ type: "series.updated", seriesId: s.id });
    markRequestsAvailable("series", s.id);
    emitEvent({ type: "history.added" });

    const detail = episodeDetail(seasonNumber, sortedEpisodeNumbers);
    const mediaType = s.isAnime ? "anime" : "series";
    db.insert(schema.organizeLog)
      .values({
        sourcePath,
        destPath: dest,
        mediaType,
        title: s.title,
        detail,
        action: method,
        status: "organized",
        message: null,
        createdAt: new Date(),
      })
      .run();

    return {
      status: "organized",
      sourcePath,
      destPath: dest,
      action: method,
      mediaType,
      title: s.title,
      detail,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.insert(schema.organizeLog)
      .values({
        sourcePath,
        destPath: null,
        mediaType: logMediaType,
        title: null,
        detail: null,
        action: null,
        status: "failed",
        message,
        createdAt: new Date(),
      })
      .run();
    throw new Error(message);
  }
}

// ---------- log ----------

export function getOrganizeLog(filter: OrganizeLogFilter = {}) {
  const db = getDb();
  const conditions = [];

  if (filter.type) conditions.push(eq(schema.organizeLog.mediaType, filter.type));
  if (filter.status) conditions.push(eq(schema.organizeLog.status, filter.status));
  if (filter.q && filter.q.trim()) {
    const term = `%${filter.q.trim()}%`;
    conditions.push(
      or(
        like(schema.organizeLog.sourcePath, term),
        like(schema.organizeLog.title, term),
        like(schema.organizeLog.detail, term)
      )
    );
  }

  const limit = Number.isFinite(filter.limit)
    ? Math.min(Math.max(Math.trunc(filter.limit as number), 1), LOG_MAX_LIMIT)
    : LOG_DEFAULT_LIMIT;

  return db
    .select()
    .from(schema.organizeLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.organizeLog.id))
    .limit(limit)
    .all();
}
