import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { searchReleases } from "@/server/indexers/release-search";
import { episodeTarget, movieTarget, seasonTarget } from "@/server/indexers/search-targets";
import { grab } from "@/server/download/download-service";
import { getSettings } from "@/server/settings/settings-service";

const INDEXER_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchAndGrab(target: ReturnType<typeof movieTarget>): Promise<boolean> {
  const releases = await searchReleases(target.search);
  const best = releases.find((r) => r.accepted);
  if (!best) return false;
  await grab(best, target.grab);
  return true;
}

export async function wantedSearchHandler(payload: unknown): Promise<string> {
  const db = getDb();
  const p = payload as { seriesId?: number; movieId?: number } | null;
  let grabbed = 0;
  let searched = 0;

  // The scheduled 24h backlog scan (no specific target) grabs at most N releases per
  // run so a large backlog fills gradually ("slowly") instead of all at once. Targeted
  // searches — a specific series/movie, e.g. from a request approval — are never capped.
  const isBacklog = !p?.seriesId && !p?.movieId;
  const maxGrabs = getSettings().maxBacklogGrabsPerRun;
  const cap = isBacklog && maxGrabs > 0 ? maxGrabs : Infinity;
  const capped = () => `searched ${searched} targets, grabbed ${grabbed} (backlog cap reached)`;

  // ---- movies ----
  const now = new Date();
  const wantedMovies = db
    .select()
    .from(schema.movies)
    .where(and(eq(schema.movies.monitored, true), isNull(schema.movies.movieFileId)))
    .all()
    .filter((m) => (p?.movieId ? m.id === p.movieId : !p?.seriesId))
    .filter((m) => {
      // availability gate
      if (m.minimumAvailability === "announced") return true;
      if (m.minimumAvailability === "inCinemas") return m.status !== "announced";
      return m.status === "released";
    });

  for (const movie of wantedMovies) {
    searched++;
    try {
      if (await searchAndGrab(movieTarget(movie.id, false))) grabbed++;
    } catch (err) {
      console.warn(`[wanted-search] movie ${movie.id} failed:`, err);
    }
    await sleep(INDEXER_DELAY_MS);
    if (grabbed >= cap) return capped();
  }

  // ---- episodes ----
  const missingEpisodes = db
    .select({
      id: schema.episodes.id,
      seriesId: schema.episodes.seriesId,
      seasonNumber: schema.episodes.seasonNumber,
    })
    .from(schema.episodes)
    .innerJoin(schema.series, eq(schema.episodes.seriesId, schema.series.id))
    .where(
      and(
        eq(schema.episodes.monitored, true),
        isNull(schema.episodes.episodeFileId),
        eq(schema.series.monitored, true),
        lt(schema.episodes.airDateUtc, now)
      )
    )
    .all()
    .filter((e) => (p?.seriesId ? e.seriesId === p.seriesId : !p?.movieId));

  // group by series+season; use a season-pack search when >= half the season is missing
  const bySeason = new Map<string, { seriesId: number; seasonNumber: number; episodeIds: number[] }>();
  for (const ep of missingEpisodes) {
    const key = `${ep.seriesId}:${ep.seasonNumber}`;
    const entry = bySeason.get(key) ?? {
      seriesId: ep.seriesId,
      seasonNumber: ep.seasonNumber,
      episodeIds: [],
    };
    entry.episodeIds.push(ep.id);
    bySeason.set(key, entry);
  }

  for (const group of bySeason.values()) {
    const totalInSeason = db
      .select({ id: schema.episodes.id })
      .from(schema.episodes)
      .where(
        and(
          eq(schema.episodes.seriesId, group.seriesId),
          eq(schema.episodes.seasonNumber, group.seasonNumber)
        )
      )
      .all().length;

    try {
      if (group.episodeIds.length >= Math.max(2, Math.ceil(totalInSeason / 2))) {
        searched++;
        if (await searchAndGrab(seasonTarget(group.seriesId, group.seasonNumber, false))) {
          grabbed++;
          await sleep(INDEXER_DELAY_MS);
          if (grabbed >= cap) return capped();
          continue;
        }
      }
      // fall back to per-episode searches (cap per season per run to stay polite)
      for (const episodeId of group.episodeIds.slice(0, 5)) {
        searched++;
        if (await searchAndGrab(episodeTarget(episodeId, false))) grabbed++;
        await sleep(INDEXER_DELAY_MS);
        if (grabbed >= cap) return capped();
      }
    } catch (err) {
      console.warn(
        `[wanted-search] series ${group.seriesId} S${group.seasonNumber} failed:`,
        err
      );
    }
  }

  return `searched ${searched} targets, grabbed ${grabbed}`;
}
