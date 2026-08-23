import {
  getTvEpisodeGroup,
  getTvEpisodeGroups,
  getTvSeason,
  type TmdbEpisodeGroupSummary,
} from "./tmdb";

/**
 * One episode, already placed in the ordering the library should use.
 *
 * TMDB numbers a show the way it was *aired*, which for long-running anime means
 * one enormous season (Bleach = S01E001–E366 + S02E01–E50). Jellyfin, the folders
 * on disk and virtually every release group instead follow TVDB's arc-based
 * seasons (Bleach = 17 seasons). TMDB publishes those alternate numberings as
 * "episode groups", so a series can pin one and have its seasons line up with the
 * rest of the world — see `series.episodeGroupId`.
 *
 * `absoluteNumber` always stays on the *aired* scale (Bleach S17E43 → 409)
 * regardless of the chosen ordering: that is the number anime fansub releases
 * carry ("[SubsPlease] Bleach - 409"), so searching and importing need it.
 */
export interface OrderedEpisode {
  tmdbEpisodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** Position in the show's overall broadcast run; null for specials. */
  absoluteNumber: number | null;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
}

export interface SeasonSummary {
  season_number: number;
  episode_count?: number;
}

/**
 * Build `(nativeSeason, nativeEpisode) → absolute number` from the length of each
 * aired season. Specials (season 0) have no absolute number.
 */
export function absoluteNumberer(
  seasonLengths: Map<number, number>
): (seasonNumber: number, episodeNumber: number) => number | null {
  const offsets = new Map<number, number>();
  let running = 0;
  for (const s of [...seasonLengths.keys()].filter((n) => n > 0).sort((a, b) => a - b)) {
    offsets.set(s, running);
    running += seasonLengths.get(s) ?? 0;
  }
  return (seasonNumber, episodeNumber) =>
    seasonNumber <= 0 ? null : (offsets.get(seasonNumber) ?? 0) + episodeNumber;
}

/** TMDB's own aired numbering — the default when no episode group is pinned. */
export async function buildAiredOrder(
  tmdbId: number,
  seasonSummaries: SeasonSummary[]
): Promise<OrderedEpisode[]> {
  const seasons = await Promise.all(
    seasonSummaries.map(async (s) => ({
      seasonNumber: s.season_number,
      episodes: (await getTvSeason(tmdbId, s.season_number)).episodes,
    }))
  );
  const lengths = new Map<number, number>();
  for (const s of seasons) lengths.set(s.seasonNumber, s.episodes.length);
  const absolute = absoluteNumberer(lengths);

  const out: OrderedEpisode[] = [];
  for (const season of seasons) {
    for (const ep of season.episodes) {
      out.push({
        tmdbEpisodeId: ep.id,
        seasonNumber: ep.season_number,
        episodeNumber: ep.episode_number,
        absoluteNumber: absolute(ep.season_number, ep.episode_number),
        title: ep.name ?? null,
        overview: ep.overview ?? null,
        airDate: ep.air_date ?? null,
        runtime: ep.runtime ?? null,
      });
    }
  }
  return out;
}

/**
 * Re-number the show per a TMDB episode group: the group's `order` becomes the
 * season number and an episode's position inside it becomes the episode number.
 * Absolute numbers still come from each episode's native (aired) coordinates.
 */
export async function buildGroupOrder(
  groupId: string,
  seasonSummaries: SeasonSummary[]
): Promise<OrderedEpisode[]> {
  const group = await getTvEpisodeGroup(groupId);
  const groups = group.groups ?? [];
  if (groups.length === 0) throw new Error(`TMDB episode group ${groupId} has no seasons`);

  // Season lengths for the absolute scale: trust the aired summaries, but never
  // go below what the group itself shows (a summary can lag behind the episodes).
  const lengths = new Map<number, number>();
  for (const s of seasonSummaries) lengths.set(s.season_number, s.episode_count ?? 0);
  for (const g of groups) {
    for (const ep of g.episodes) {
      lengths.set(ep.season_number, Math.max(lengths.get(ep.season_number) ?? 0, ep.episode_number));
    }
  }
  const absolute = absoluteNumberer(lengths);

  // Most groups reserve order 0 for specials; a group that starts at 0 without a
  // specials season is 0-based instead, so shift it up rather than inventing a
  // "Specials" season out of its first real one.
  const hasSpecials = groups.some((g) => g.order === 0 && /special/i.test(g.name));
  const shift = !hasSpecials && groups.some((g) => g.order === 0) ? 1 : 0;

  const out: OrderedEpisode[] = [];
  for (const g of groups) {
    const seasonNumber = g.order + shift;
    const ordered = [...g.episodes].sort((a, b) => a.order - b.order);
    ordered.forEach((ep, index) => {
      out.push({
        tmdbEpisodeId: ep.id,
        seasonNumber,
        // `order` is 0-based inside the group; fall back to position for safety.
        episodeNumber: (Number.isFinite(ep.order) ? ep.order : index) + 1,
        absoluteNumber: absolute(ep.season_number, ep.episode_number),
        title: ep.name ?? null,
        overview: ep.overview ?? null,
        airDate: ep.air_date ?? null,
        runtime: ep.runtime ?? null,
      });
    });
  }
  return out;
}

/** Aired order, or the pinned episode group when the series has one. */
export async function buildEpisodeOrder(
  tmdbId: number,
  seasonSummaries: SeasonSummary[],
  episodeGroupId: string | null
): Promise<OrderedEpisode[]> {
  if (!episodeGroupId) return buildAiredOrder(tmdbId, seasonSummaries);
  try {
    return await buildGroupOrder(episodeGroupId, seasonSummaries);
  } catch (err) {
    // A deleted/broken group must not take the whole refresh down with it.
    console.warn(`[episode-order] group ${episodeGroupId} unusable, falling back to aired:`, err);
    return buildAiredOrder(tmdbId, seasonSummaries);
  }
}

/**
 * The grouping that matches TVDB — what Jellyfin/Plex show and what release
 * groups name their files after. Anime are pinned to it automatically on add.
 */
export function pickTvdbOrderGroup(
  groups: TmdbEpisodeGroupSummary[]
): TmdbEpisodeGroupSummary | null {
  const candidates = groups.filter((g) => /\btvdb\b/i.test(g.name) && g.group_count > 1);
  if (candidates.length === 0) return null;
  // Prefer an "original air date" (type 1) grouping, then the most complete one.
  return candidates.sort(
    (a, b) => Number(b.type === 1) - Number(a.type === 1) || b.episode_count - a.episode_count
  )[0];
}

/**
 * Pick the ordering a newly-added series should use. Only anime get an automatic
 * TVDB grouping — for everything else TMDB's aired order already agrees with it.
 */
export async function defaultEpisodeGroupId(
  tmdbId: number,
  isAnime: boolean
): Promise<string | null> {
  if (!isAnime) return null;
  try {
    const { results } = await getTvEpisodeGroups(tmdbId);
    return pickTvdbOrderGroup(results ?? [])?.id ?? null;
  } catch (err) {
    console.warn(`[episode-order] could not list episode groups for ${tmdbId}:`, err);
    return null;
  }
}


// ---------- choosing an ordering from evidence ----------

/** A candidate ordering, scored against the episode numbers a library uses. */
export interface OrderingScore {
  /** TMDB episode-group id; null = TMDB's aired order. */
  id: string | null;
  name: string;
  seasonCount: number;
  /** Observed coordinates this ordering can explain. */
  covered: number;
  total: number;
  /** covered / total (1 when there was nothing to explain). */
  coverage: number;
}

/** An `SxxExx` coordinate observed somewhere outside media-box (disk, Sonarr…). */
export interface ObservedCoordinate {
  seasonNumber: number;
  episodeNumber: number;
}

const coord = (s: number, e: number) => `${s}:${e}`;

/** Coordinates TMDB's aired order provides, straight from the season summaries. */
function airedCoordinates(seasonSummaries: SeasonSummary[]): Set<string> {
  const out = new Set<string>();
  for (const s of seasonSummaries) {
    for (let e = 1; e <= (s.episode_count ?? 0); e++) out.add(coord(s.season_number, e));
  }
  return out;
}

function coverageOf(available: Set<string>, observed: ObservedCoordinate[]): {
  covered: number;
  total: number;
  coverage: number;
} {
  const total = observed.length;
  if (total === 0) return { covered: 0, total: 0, coverage: 1 };
  let covered = 0;
  for (const o of observed) if (available.has(coord(o.seasonNumber, o.episodeNumber))) covered++;
  return { covered, total, coverage: covered / total };
}

/**
 * Score TMDB's aired order and the most promising episode groups against the
 * season/episode numbers a library actually uses.
 *
 * Only a few groups are fetched (TVDB grouping first, then other aired-date
 * ones): every candidate costs a TMDB call, and a library-wide audit runs this
 * for hundreds of shows. Scoring stops early once a candidate explains
 * everything, so the common case is one extra call.
 */
export async function scoreOrderings(
  tmdbId: number,
  seasonSummaries: SeasonSummary[],
  observed: ObservedCoordinate[],
  opts: { maxGroups?: number } = {}
): Promise<OrderingScore[]> {
  const airedSeasons = seasonSummaries.filter((s) => s.season_number > 0).length;
  const scores: OrderingScore[] = [
    {
      id: null,
      name: "Aired (TMDB)",
      seasonCount: airedSeasons,
      ...coverageOf(airedCoordinates(seasonSummaries), observed),
    },
  ];
  if (observed.length === 0) return scores;

  let groups: TmdbEpisodeGroupSummary[] = [];
  try {
    groups = (await getTvEpisodeGroups(tmdbId)).results ?? [];
  } catch (err) {
    console.warn(`[episode-order] could not list episode groups for ${tmdbId}:`, err);
    return scores;
  }

  // TVDB order first — it is what Sonarr, Jellyfin and Plex all count by — then
  // other "original air date" groupings, then whatever is left.
  const tvdb = pickTvdbOrderGroup(groups);
  const ranked = [
    ...(tvdb ? [tvdb] : []),
    ...groups.filter((g) => g !== tvdb && g.type === 1 && g.group_count > 1),
    ...groups.filter((g) => g !== tvdb && g.type !== 1 && g.group_count > 1),
  ].slice(0, opts.maxGroups ?? 3);

  for (const g of ranked) {
    if (scores.some((s) => s.coverage === 1 && s.total > 0)) break; // already perfect
    try {
      const detail = await getTvEpisodeGroup(g.id);
      const available = new Set<string>();
      const hasSpecials = (detail.groups ?? []).some(
        (x) => x.order === 0 && /special/i.test(x.name)
      );
      const shift = !hasSpecials && (detail.groups ?? []).some((x) => x.order === 0) ? 1 : 0;
      for (const season of detail.groups ?? []) {
        season.episodes.forEach((ep, index) =>
          available.add(
            coord(season.order + shift, (Number.isFinite(ep.order) ? ep.order : index) + 1)
          )
        );
      }
      scores.push({
        id: g.id,
        name: g.name,
        seasonCount: g.group_count,
        ...coverageOf(available, observed),
      });
    } catch (err) {
      console.warn(`[episode-order] episode group ${g.id} unreadable:`, err);
    }
  }
  return scores;
}

/**
 * The ordering a library's own numbering points at, or null to keep the current
 * one. A challenger has to explain clearly more of the observed episodes than
 * the incumbent does (`MIN_GAIN`) and get most of them right — a library is
 * always a bit messy, and renumbering on thin evidence is worse than leaving it.
 */
export const MIN_ORDERING_COVERAGE = 0.6;
export const MIN_ORDERING_GAIN = 0.15;

export function bestOrdering(
  scores: OrderingScore[],
  currentId: string | null
): OrderingScore | null {
  if (scores.length === 0) return null;
  const current = scores.find((s) => s.id === (currentId ?? null));
  const best = [...scores].sort((a, b) => b.coverage - a.coverage || b.total - a.total)[0];
  if (best.total === 0) return null;
  if (best.id === (currentId ?? null)) return null;
  if (best.coverage < MIN_ORDERING_COVERAGE) return null;
  if (current && best.coverage - current.coverage < MIN_ORDERING_GAIN) return null;
  return best;
}
