/**
 * Subtitle service: finds video files missing subtitles in the configured
 * languages, downloads them from the active provider, and writes them as
 * sidecar files next to the video (e.g. `Movie (2020).en.srt`) — the Bazarr/
 * Jellyfin/Plex convention.
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSettings } from "@/server/settings/settings-service";
import { enabledProviders } from "./providers/registry";
import type { ProviderCandidate, ProviderSearchQuery } from "./providers/types";
import { emitEvent } from "@/server/events/bus";
import { resolveMediaPath } from "@/server/library/resolve-media";
import { probeMediaInfo, type MediaInfo } from "@/server/library/media-info";

export type SubtitleTarget =
  | { kind: "movie"; id: number }
  | { kind: "episode"; id: number };

/** A search scope: a single movie/episode, or a whole series (all its episodes). */
export type SubtitleScope = SubtitleTarget | { kind: "series"; id: number };

export interface WantedSubtitle {
  target: SubtitleTarget;
  language: string;
}

/** Configured wanted languages (ISO 639-1), empty when no provider is enabled. */
export function wantedLanguages(): string[] {
  const s = getSettings();
  if (enabledProviders().length === 0) return [];
  return s.subtitleLanguages
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

interface VideoRef {
  /** Absolute path of the video file. */
  absVideo: string;
  /** Library root the sidecar path is stored relative to (movie.path / series.path). */
  root: string;
  query: Omit<ProviderSearchQuery, "language" | "hearingImpaired">;
}

function movieVideo(movieId: number): VideoRef | null {
  const db = getDb();
  const row = db
    .select({
      moviePath: schema.movies.path,
      imdbId: schema.movies.imdbId,
      tmdbId: schema.movies.tmdbId,
      title: schema.movies.title,
      year: schema.movies.year,
      relativePath: schema.movieFiles.relativePath,
    })
    .from(schema.movies)
    .innerJoin(schema.movieFiles, eq(schema.movieFiles.id, schema.movies.movieFileId))
    .where(eq(schema.movies.id, movieId))
    .get();
  if (!row) return null;
  return {
    absVideo: path.join(row.moviePath, row.relativePath),
    root: row.moviePath,
    query: { imdbId: row.imdbId, tmdbId: row.tmdbId, title: row.title, year: row.year },
  };
}

function episodeVideo(episodeId: number): VideoRef | null {
  const db = getDb();
  const row = db
    .select({
      seriesPath: schema.series.path,
      parentImdbId: schema.series.imdbId,
      parentTmdbId: schema.series.tmdbId,
      seriesTitle: schema.series.title,
      seriesYear: schema.series.year,
      seasonNumber: schema.episodes.seasonNumber,
      episodeNumber: schema.episodes.episodeNumber,
      relativePath: schema.episodeFiles.relativePath,
    })
    .from(schema.episodes)
    .innerJoin(schema.episodeFiles, eq(schema.episodeFiles.id, schema.episodes.episodeFileId))
    .innerJoin(schema.series, eq(schema.series.id, schema.episodes.seriesId))
    .where(eq(schema.episodes.id, episodeId))
    .get();
  if (!row) return null;
  return {
    absVideo: path.join(row.seriesPath, row.relativePath),
    root: row.seriesPath,
    query: {
      parentImdbId: row.parentImdbId,
      parentTmdbId: row.parentTmdbId,
      title: row.seriesTitle,
      year: row.seriesYear,
      season: row.seasonNumber,
      episode: row.episodeNumber,
    },
  };
}

/** Sidecar path (e.g. "…/Movie (2020).en.srt") for a video + language. */
function sidecarPath(absVideo: string, language: string): string {
  const dir = path.dirname(absVideo);
  const base = path.basename(absVideo, path.extname(absVideo));
  return path.join(dir, `${base}.${language}.srt`);
}

function hasSubtitle(target: SubtitleTarget, language: string): boolean {
  const db = getDb();
  const where =
    target.kind === "movie"
      ? and(eq(schema.subtitleFiles.movieId, target.id), eq(schema.subtitleFiles.language, language))
      : and(
          eq(schema.subtitleFiles.episodeId, target.id),
          eq(schema.subtitleFiles.language, language)
        );
  return !!db.select({ id: schema.subtitleFiles.id }).from(schema.subtitleFiles).where(where).get();
}

/**
 * All (target, language) pairs that have a video file on disk but no subtitle
 * recorded in one of the wanted languages. Optionally scoped to one title.
 */
export function wantedSubtitles(scope?: SubtitleScope): WantedSubtitle[] {
  const langs = wantedLanguages();
  if (langs.length === 0) return [];
  const db = getDb();
  const wanted: WantedSubtitle[] = [];

  const movieIds =
    scope?.kind === "movie"
      ? [scope.id]
      : scope
        ? []
        : db
            .select({ id: schema.movies.id })
            .from(schema.movies)
            .where(isNotNull(schema.movies.movieFileId))
            .all()
            .map((r) => r.id);
  for (const id of movieIds) {
    for (const language of langs) {
      if (!hasSubtitle({ kind: "movie", id }, language)) {
        wanted.push({ target: { kind: "movie", id }, language });
      }
    }
  }

  const episodeIds =
    scope?.kind === "episode"
      ? [scope.id]
      : scope?.kind === "series"
        ? db
            .select({ id: schema.episodes.id })
            .from(schema.episodes)
            .where(
              and(
                eq(schema.episodes.seriesId, scope.id),
                isNotNull(schema.episodes.episodeFileId)
              )
            )
            .all()
            .map((r) => r.id)
        : scope
          ? []
          : // Whole-library backlog: skip anime (usually has embedded subs) — anime
            // is only fetched when explicitly scoped (a manual search).
            db
              .select({ id: schema.episodes.id })
              .from(schema.episodes)
              .innerJoin(schema.series, eq(schema.series.id, schema.episodes.seriesId))
              .where(
                and(
                  isNotNull(schema.episodes.episodeFileId),
                  eq(schema.series.isAnime, false)
                )
              )
              .all()
              .map((r) => r.id);
  for (const id of episodeIds) {
    for (const language of langs) {
      if (!hasSubtitle({ kind: "episode", id }, language)) {
        wanted.push({ target: { kind: "episode", id }, language });
      }
    }
  }

  return wanted;
}

/**
 * Search + download one subtitle for a target/language, writing the sidecar and
 * recording it. Returns true if a subtitle was downloaded.
 */
export async function downloadSubtitleFor(
  target: SubtitleTarget,
  language: string
): Promise<boolean> {
  if (hasSubtitle(target, language)) return false;
  const ref = target.kind === "movie" ? movieVideo(target.id) : episodeVideo(target.id);
  if (!ref) return false;

  const providers = enabledProviders();
  if (providers.length === 0) return false;
  const hi = getSettings().subtitleHearingImpaired;
  const q: ProviderSearchQuery = { ...ref.query, language, hearingImpaired: hi };

  // Try providers in the configured priority order; first one with a hit wins.
  let best: ProviderCandidate | null = null;
  for (const provider of providers) {
    try {
      const cands = await provider.search(q);
      if (cands.length > 0) {
        best = cands[0];
        break;
      }
    } catch {
      /* provider failed — fall through to the next */
    }
  }
  if (!best) return false;

  let content: string;
  try {
    content = await best.download();
  } catch {
    return false;
  }
  await persistSubtitle(target, ref, language, content, best.providerId, best.hearingImpaired);
  return true;
}

/**
 * Write a subtitle sidecar + record it, replacing any prior record for the same
 * (deterministic) sidecar path, then emit the update event.
 */
async function persistSubtitle(
  target: SubtitleTarget,
  ref: VideoRef,
  language: string,
  content: string,
  providerId: string,
  hearingImpaired: boolean
): Promise<void> {
  const abs = sidecarPath(ref.absVideo, language);
  await fs.writeFile(abs, content, "utf8");
  const relativePath = path.relative(ref.root, abs);

  const db = getDb();
  const idCol =
    target.kind === "movie" ? schema.subtitleFiles.movieId : schema.subtitleFiles.episodeId;
  db.delete(schema.subtitleFiles)
    .where(and(eq(idCol, target.id), eq(schema.subtitleFiles.relativePath, relativePath)))
    .run();
  db.insert(schema.subtitleFiles)
    .values({
      movieId: target.kind === "movie" ? target.id : null,
      episodeId: target.kind === "episode" ? target.id : null,
      language,
      relativePath,
      provider: providerId,
      hearingImpaired,
      addedAt: new Date(),
    })
    .run();

  if (target.kind === "movie") emitEvent({ type: "movie.updated", movieId: target.id });
  else {
    const seriesId = db
      .select({ seriesId: schema.episodes.seriesId })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, target.id))
      .get()?.seriesId;
    if (seriesId) emitEvent({ type: "series.updated", seriesId });
  }
}

// ---------- Interactive (manual) subtitle search ----------

export interface SubtitleCandidateResult {
  /** Opaque token to pass back to downloadSubtitleCandidate(). */
  id: string;
  providerId: string;
  providerName: string;
  language: string;
  release: string;
  hearingImpaired: boolean;
  score: number;
}

interface CachedCandidate {
  download: () => Promise<string>;
  providerId: string;
  hearingImpaired: boolean;
  language: string;
  expires: number;
}
// Candidates carry a provider-specific download closure that can't cross HTTP, so
// we cache them briefly and hand the client an opaque id to grab one later.
const CANDIDATE_CACHE = new Map<string, CachedCandidate>();
const CACHE_TTL_MS = 15 * 60 * 1000;

function pruneCandidateCache(now: number): void {
  for (const [k, v] of CANDIDATE_CACHE) if (v.expires < now) CANDIDATE_CACHE.delete(k);
}

/** Search all enabled providers for one target/language and return candidates (no download). */
export async function searchSubtitleCandidates(
  target: SubtitleTarget,
  language: string
): Promise<SubtitleCandidateResult[]> {
  const ref = target.kind === "movie" ? movieVideo(target.id) : episodeVideo(target.id);
  if (!ref) return [];
  const providers = enabledProviders();
  if (providers.length === 0) return [];
  const hi = getSettings().subtitleHearingImpaired;
  const q: ProviderSearchQuery = { ...ref.query, language, hearingImpaired: hi };

  const now = Date.now();
  pruneCandidateCache(now);
  const out: SubtitleCandidateResult[] = [];
  for (const provider of providers) {
    let cands: ProviderCandidate[];
    try {
      cands = await provider.search(q);
    } catch {
      continue;
    }
    for (const c of cands.slice(0, 20)) {
      const id = crypto.randomUUID();
      CANDIDATE_CACHE.set(id, {
        download: c.download,
        providerId: c.providerId,
        hearingImpaired: c.hearingImpaired,
        language,
        expires: now + CACHE_TTL_MS,
      });
      out.push({
        id,
        providerId: c.providerId,
        providerName: provider.name,
        language: c.language,
        release: c.release,
        hearingImpaired: c.hearingImpaired,
        score: c.score,
      });
    }
  }
  return out;
}

/** Download a specific candidate previously returned by searchSubtitleCandidates(). */
export async function downloadSubtitleCandidate(
  target: SubtitleTarget,
  candidateId: string
): Promise<boolean> {
  const cached = CANDIDATE_CACHE.get(candidateId);
  if (!cached || cached.expires < Date.now()) {
    CANDIDATE_CACHE.delete(candidateId);
    return false;
  }
  const ref = target.kind === "movie" ? movieVideo(target.id) : episodeVideo(target.id);
  if (!ref) return false;
  let content: string;
  try {
    content = await cached.download();
  } catch {
    return false;
  }
  await persistSubtitle(target, ref, cached.language, content, cached.providerId, cached.hearingImpaired);
  CANDIDATE_CACHE.delete(candidateId);
  return true;
}

// ---------- Track listing + resolution (for the in-app player) ----------

export interface SubtitleTrackInfo {
  id: number;
  language: string;
  hearingImpaired: boolean;
}

export function listSubtitleTracks(target: { movieId?: number; episodeId?: number }): SubtitleTrackInfo[] {
  const db = getDb();
  const rows = target.movieId
    ? db.select().from(schema.subtitleFiles).where(eq(schema.subtitleFiles.movieId, target.movieId)).all()
    : target.episodeId
      ? db.select().from(schema.subtitleFiles).where(eq(schema.subtitleFiles.episodeId, target.episodeId)).all()
      : [];
  return rows.map((r) => ({ id: r.id, language: r.language, hearingImpaired: r.hearingImpaired }));
}

/** Codecs we can turn into a WebVTT text track (image subs like PGS/VobSub can't). */
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "mov_text",
  "webvtt",
  "vtt",
  "text",
  "subviewer",
]);

export interface EmbeddedSubtitleTrack {
  /** 0-based position among the file's subtitle streams → ffmpeg `-map 0:s:index`. */
  index: number;
  language: string | null;
  codec: string;
}

/**
 * Text-based subtitle streams muxed inside the video file itself (e.g. an anime
 * MKV carrying soft ASS/SRT tracks). Image-based subs (PGS/VobSub) are excluded —
 * they can't be rendered as WebVTT text. Uses the stored ffprobe result when
 * present, otherwise probes on demand so it also works for files imported before
 * media-info probing existed. The returned `index` maps directly to ffmpeg's
 * `0:s:index` for on-the-fly extraction.
 */
export async function listEmbeddedSubtitleTracks(
  target: SubtitleTarget
): Promise<EmbeddedSubtitleTrack[]> {
  const resolved = resolveMediaPath(target.kind, target.id);
  if (!resolved) return [];

  const db = getDb();
  let info: MediaInfo | null | undefined;
  if (target.kind === "movie") {
    const movie = db.select().from(schema.movies).where(eq(schema.movies.id, target.id)).get();
    if (movie?.movieFileId) {
      info = db
        .select({ mediaInfo: schema.movieFiles.mediaInfo })
        .from(schema.movieFiles)
        .where(eq(schema.movieFiles.id, movie.movieFileId))
        .get()?.mediaInfo as MediaInfo | null | undefined;
    }
  } else {
    const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, target.id)).get();
    if (ep?.episodeFileId) {
      info = db
        .select({ mediaInfo: schema.episodeFiles.mediaInfo })
        .from(schema.episodeFiles)
        .where(eq(schema.episodeFiles.id, ep.episodeFileId))
        .get()?.mediaInfo as MediaInfo | null | undefined;
    }
  }

  // Stored probe present → trust it (even if it lists no subtitles). Absent → probe now.
  let streams = info ? (info.subtitles ?? []) : null;
  if (streams === null) streams = (await probeMediaInfo(resolved.absPath))?.subtitles ?? [];

  return streams
    .map((s, index) => ({ index, language: s.language, codec: (s.codec || "").toLowerCase() }))
    .filter((s) => TEXT_SUBTITLE_CODECS.has(s.codec));
}

/** Absolute on-disk path of a subtitle sidecar file, or null if unknown. */
export function subtitleAbsPath(id: number): string | null {
  const db = getDb();
  const row = db.select().from(schema.subtitleFiles).where(eq(schema.subtitleFiles.id, id)).get();
  if (!row) return null;
  if (row.movieId != null) {
    const m = db
      .select({ path: schema.movies.path })
      .from(schema.movies)
      .where(eq(schema.movies.id, row.movieId))
      .get();
    return m ? path.join(m.path, row.relativePath) : null;
  }
  if (row.episodeId != null) {
    const s = db
      .select({ path: schema.series.path })
      .from(schema.series)
      .innerJoin(schema.episodes, eq(schema.episodes.seriesId, schema.series.id))
      .where(eq(schema.episodes.id, row.episodeId))
      .get();
    return s ? path.join(s.path, row.relativePath) : null;
  }
  return null;
}

// ---------- Discover existing on-disk subtitle files (sidecars + Subs/ subfolders) ----------

const SUB_EXTS = new Set([".srt", ".vtt", ".ass", ".ssa", ".sub"]);

const SUB_LANG_MAP: Record<string, string> = {
  english: "en", eng: "en", en: "en",
  spanish: "es", spa: "es", esp: "es", es: "es",
  french: "fr", fre: "fr", fra: "fr", fr: "fr",
  german: "de", ger: "de", deu: "de", de: "de",
  italian: "it", ita: "it",
  portuguese: "pt", por: "pt", pt: "pt", brazilian: "pt",
  dutch: "nl", nld: "nl", dut: "nl", nl: "nl",
  japanese: "jpn", jpn: "ja", ja: "ja",
  korean: "kor", kor: "ko", ko: "ko",
  chinese: "chi", chi: "zh", zho: "zh", zh: "zh",
  russian: "rus", rus: "ru", ru: "ru",
  arabic: "ara", ara: "ar", ar: "ar",
  greek: "gre", gre: "el", ell: "el", el: "el",
  hindi: "hin", hin: "hi",
  turkish: "tur", tur: "tr",
  polish: "pol", pol: "pl",
  swedish: "swe", swe: "sv",
};

/** Best-effort ISO-639-1 from a subtitle filename (first language token found). */
function langFromName(name: string): string {
  const tokens = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) {
    const hit = SUB_LANG_MAP[t];
    if (hit) return SUB_LANG_MAP[hit] ?? hit; // normalize 3-letter → 2-letter
  }
  return "und";
}

async function discoverSubtitleFiles(
  absVideo: string
): Promise<{ absPath: string; language: string }[]> {
  const videoDir = path.dirname(absVideo);
  const videoBase = path.basename(absVideo, path.extname(absVideo));
  const videoBaseLc = videoBase.toLowerCase();
  const out: { absPath: string; language: string }[] = [];

  let entries;
  try {
    entries = await fs.readdir(videoDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(videoDir, e.name);
    if (e.isFile()) {
      if (!SUB_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      const base = path.basename(e.name, path.extname(e.name));
      // Sidecar sharing the video basename: "Movie.2020.en.srt" next to "Movie.2020.mkv".
      if (base.toLowerCase().startsWith(videoBaseLc)) {
        out.push({ absPath: abs, language: langFromName(base.slice(videoBase.length)) });
      }
    } else if (e.isDirectory()) {
      // A subtitles subfolder ("Subs"/"Subtitles") or one named after the video.
      const dirLc = e.name.toLowerCase();
      if (/^(subs?|subtitles?)$/.test(dirLc) || dirLc === videoBaseLc) {
        let subEntries;
        try {
          subEntries = await fs.readdir(abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of subEntries) {
          if (s.isFile() && SUB_EXTS.has(path.extname(s.name).toLowerCase())) {
            out.push({
              absPath: path.join(abs, s.name),
              language: langFromName(path.basename(s.name, path.extname(s.name))),
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Scan a movie/episode's on-disk folder for existing subtitle files and record any
 * not already known (provider "disk"), so the player lists them. Never throws.
 */
export async function syncDiskSubtitles(target: {
  movieId?: number;
  episodeId?: number;
}): Promise<void> {
  try {
    const ref = target.movieId
      ? movieVideo(target.movieId)
      : target.episodeId
        ? episodeVideo(target.episodeId)
        : null;
    if (!ref) return;
    const found = await discoverSubtitleFiles(ref.absVideo);
    if (found.length === 0) return;

    const db = getDb();
    const known = new Set(
      (target.movieId
        ? db
            .select({ rp: schema.subtitleFiles.relativePath })
            .from(schema.subtitleFiles)
            .where(eq(schema.subtitleFiles.movieId, target.movieId))
            .all()
        : db
            .select({ rp: schema.subtitleFiles.relativePath })
            .from(schema.subtitleFiles)
            .where(eq(schema.subtitleFiles.episodeId, target.episodeId!))
            .all()
      ).map((r) => r.rp)
    );
    for (const f of found) {
      const relativePath = path.relative(ref.root, f.absPath);
      if (known.has(relativePath)) continue;
      db.insert(schema.subtitleFiles)
        .values({
          movieId: target.movieId ?? null,
          episodeId: target.episodeId ?? null,
          language: f.language,
          relativePath,
          provider: "disk",
          hearingImpaired: /\b(sdh|hi|cc)\b/i.test(path.basename(f.absPath)),
          addedAt: new Date(),
        })
        .run();
      known.add(relativePath);
    }
  } catch {
    /* discovery is best-effort — never block playback */
  }
}
