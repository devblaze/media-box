import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { ProfileLike } from "@/server/parser/scoring";
import type { QualityModel } from "@/server/parser/quality";
import type { SearchTarget } from "./release-search";
import type { GrabTarget } from "@/server/download/download-service";

function loadProfile(id: number): ProfileLike {
  const row = getDb()
    .select()
    .from(schema.qualityProfiles)
    .where(eq(schema.qualityProfiles.id, id))
    .get();
  if (!row) throw new Error(`Quality profile ${id} not found`);
  return {
    cutoffQualityId: row.cutoffQualityId,
    upgradeAllowed: row.upgradeAllowed,
    items: row.items as ProfileLike["items"],
    preferredTerms: row.preferredTerms,
    requiredTerms: row.requiredTerms,
    ignoredTerms: row.ignoredTerms,
  };
}

export function episodeTarget(episodeId: number, interactive: boolean): {
  search: SearchTarget;
  grab: GrabTarget;
} {
  const db = getDb();
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get();
  if (!episode) throw new Error(`Episode ${episodeId} not found`);
  const s = db.select().from(schema.series).where(eq(schema.series.id, episode.seriesId)).get();
  if (!s) throw new Error(`Series ${episode.seriesId} not found`);
  const currentFile = episode.episodeFileId
    ? db.select().from(schema.episodeFiles).where(eq(schema.episodeFiles.id, episode.episodeFileId)).get()
    : null;
  return {
    search: {
      mediaType: "series",
      profile: loadProfile(s.qualityProfileId),
      targetTitles: [s.title],
      targetYear: s.year,
      seasonNumber: episode.seasonNumber,
      episodeNumbers: [episode.episodeNumber],
      allowSeasonPack: false,
      currentQuality: (currentFile?.quality as QualityModel) ?? null,
      query: s.title,
      interactive,
    },
    grab: { mediaType: "series", seriesId: s.id, episodeIds: [episode.id] },
  };
}

export function seasonTarget(seriesId: number, seasonNumber: number, interactive: boolean): {
  search: SearchTarget;
  grab: GrabTarget;
} {
  const db = getDb();
  const s = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!s) throw new Error(`Series ${seriesId} not found`);
  const episodes = db
    .select()
    .from(schema.episodes)
    .where(
      and(eq(schema.episodes.seriesId, seriesId), eq(schema.episodes.seasonNumber, seasonNumber))
    )
    .all();
  return {
    search: {
      mediaType: "series",
      profile: loadProfile(s.qualityProfileId),
      targetTitles: [s.title],
      targetYear: s.year,
      seasonNumber,
      episodeNumbers: episodes.map((e) => e.episodeNumber),
      allowSeasonPack: true,
      currentQuality: null,
      query: s.title,
      interactive,
    },
    grab: { mediaType: "series", seriesId, episodeIds: episodes.map((e) => e.id) },
  };
}

export function movieTarget(movieId: number, interactive: boolean): {
  search: SearchTarget;
  grab: GrabTarget;
} {
  const db = getDb();
  const m = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!m) throw new Error(`Movie ${movieId} not found`);
  const currentFile = m.movieFileId
    ? db.select().from(schema.movieFiles).where(eq(schema.movieFiles.id, m.movieFileId)).get()
    : null;
  return {
    search: {
      mediaType: "movie",
      profile: loadProfile(m.qualityProfileId),
      targetTitles: [m.title],
      targetYear: m.year,
      currentQuality: (currentFile?.quality as QualityModel) ?? null,
      query: m.year ? `${m.title} ${m.year}` : m.title,
      interactive,
    },
    grab: { mediaType: "movie", movieId },
  };
}
