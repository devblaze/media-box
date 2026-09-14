import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { queryIndexer } from "@/server/indexers/query";
import { parseTitle } from "@/server/parser/release-parser";
import { evaluate, type ReleaseCandidate } from "@/server/parser/scoring";
import type { ProfileLike } from "@/server/parser/scoring";
import type { QualityModel } from "@/server/parser/quality";
import { normalizeTitle } from "@/server/library/naming-utils";
import {
  episodesWithDownloadInFlight,
  moviesWithDownloadInFlight,
  grab,
} from "@/server/download/download-service";
import { episodeFilesOnDisk, movieFileOnDisk, type FileOnDisk } from "@/server/library/on-disk";

const TV_CATS = [5000, 5030, 5040];
const MOVIE_CATS = [2000, 2010, 2020, 2030, 2040, 2045, 2060];

interface LibraryIndexes {
  seriesByTitle: Map<string, typeof schema.series.$inferSelect>;
  moviesByTitle: Map<string, typeof schema.movies.$inferSelect>;
  profiles: Map<number, ProfileLike>;
}

function buildIndexes(): LibraryIndexes {
  const db = getDb();
  const seriesRows = db.select().from(schema.series).where(eq(schema.series.monitored, true)).all();
  const movieRows = db.select().from(schema.movies).where(eq(schema.movies.monitored, true)).all();
  const profileRows = db.select().from(schema.qualityProfiles).all();
  return {
    seriesByTitle: new Map(seriesRows.map((s) => [normalizeTitle(s.title), s])),
    moviesByTitle: new Map(movieRows.map((m) => [normalizeTitle(m.title), m])),
    profiles: new Map(
      profileRows.map((p) => [
        p.id,
        {
          cutoffQualityId: p.cutoffQualityId,
          upgradeAllowed: p.upgradeAllowed,
          items: p.items as ProfileLike["items"],
        },
      ])
    ),
  };
}

export async function rssSyncHandler(): Promise<string> {
  const db = getDb();
  const indexerRows = db
    .select()
    .from(schema.indexers)
    .where(and(eq(schema.indexers.enabled, true), eq(schema.indexers.enableRss, true)))
    .all();
  if (indexerRows.length === 0) return "no RSS-enabled indexers";

  const lib = buildIndexes();
  if (lib.seriesByTitle.size === 0 && lib.moviesByTitle.size === 0) return "library empty";

  let grabbed = 0;
  let seen = 0;
  // Snapshot once per run, then keep it current as this run grabs.
  const inFlight = episodesWithDownloadInFlight();
  const moviesInFlight = moviesWithDownloadInFlight();
  /**
   * What each series/movie actually has in its folder, whatever its file pointer
   * says (see on-disk.ts). Each answer costs a folder walk, so they are built at
   * most once per run and only for the titles this feed actually matched.
   */
  const episodesOnDisk = new Map<number, Map<number, FileOnDisk>>();
  const movieOnDisk = new Map<number, boolean>();

  for (const indexer of indexerRows) {
    let items;
    try {
      // empty-query search = RSS mode (torznab convention; built-ins fetch their
      // "recent" feed for the same empty query).
      items = await queryIndexer(indexer, {
        t: "search",
        cat: [...TV_CATS, ...MOVIE_CATS],
        limit: 100,
      });
    } catch (err) {
      console.warn(`[rss-sync] indexer '${indexer.name}' failed:`, err);
      continue;
    }

    for (const item of items) {
      seen++;
      const parsed = parseTitle(item.title);
      const candidate: ReleaseCandidate = {
        guid: item.guid,
        indexerId: indexer.id,
        indexerName: indexer.name,
        title: item.title,
        size: item.size,
        seeders: item.seeders,
        leechers: item.leechers,
        downloadUrl: item.link,
        magnetUrl: item.magnetUrl,
        infoHash: item.infoHash,
        parsed,
      };

      try {
        if (parsed.isTv) {
          const s = lib.seriesByTitle.get(parsed.normalizedTitle);
          if (!s || parsed.episodes.length !== 1) continue;
          // Anime feeds (SubsPlease, Erai-raws…) name episodes by their absolute
          // number and no season — "[SubsPlease] Bleach - 409" — so those match
          // through `episodes.absoluteNumber` instead of an SxxExx coordinate.
          const byAbsolute = parsed.isAbsolute === true && s.isAnime;
          if (!byAbsolute && parsed.seasons.length !== 1) continue;
          const episode = db
            .select()
            .from(schema.episodes)
            .where(
              and(
                eq(schema.episodes.seriesId, s.id),
                byAbsolute
                  ? eq(schema.episodes.absoluteNumber, parsed.episodes[0])
                  : and(
                      eq(schema.episodes.seasonNumber, parsed.seasons[0]),
                      eq(schema.episodes.episodeNumber, parsed.episodes[0])
                    ),
                eq(schema.episodes.monitored, true)
              )
            )
            .get();
          if (!episode) continue;
          // An RSS feed lists the same episode once per release group. Only the
          // first one is grabbed: the rest would pile onto the same episode and
          // whichever landed last would win (see episodesWithDownloadInFlight).
          if (inFlight.has(episode.id)) continue;
          const currentFile = episode.episodeFileId
            ? db
                .select()
                .from(schema.episodeFiles)
                .where(eq(schema.episodeFiles.id, episode.episodeFileId))
                .get()
            : null;
          // No file record doesn't mean no file: a renumber drops the pointer and
          // leaves the episode on disk. Feeding that file's quality in as the
          // current one puts the stray copy through the same upgrade/cutoff rules
          // a linked one gets — so a repeat of what's there is never re-grabbed,
          // and a genuine upgrade still is.
          let strayQuality: QualityModel | null = null;
          if (!currentFile) {
            let onDisk = episodesOnDisk.get(s.id);
            if (!onDisk) {
              onDisk = await episodeFilesOnDisk(s.id);
              episodesOnDisk.set(s.id, onDisk);
            }
            strayQuality = onDisk.get(episode.id)?.quality ?? null;
          }
          const profile = lib.profiles.get(s.qualityProfileId);
          if (!profile) continue;
          const evaluation = evaluate(candidate, {
            profile,
            targetTitles: [s.title],
            targetYear: s.year,
            seasonNumber: episode.seasonNumber,
            episodeNumbers: [episode.episodeNumber],
            absoluteEpisodeNumbers:
              episode.absoluteNumber != null ? [episode.absoluteNumber] : [],
            currentQuality: (currentFile?.quality as QualityModel) ?? strayQuality,
            minimumSeeders: indexer.minimumSeeders,
            mediaType: "series",
          });
          if (!evaluation.accepted) continue;
          await grab({ ...candidate, ...evaluation }, {
            mediaType: "series",
            seriesId: s.id,
            episodeIds: [episode.id],
          });
          inFlight.add(episode.id); // later items in this same feed must not re-grab it
          grabbed++;
        } else {
          const m = lib.moviesByTitle.get(parsed.normalizedTitle);
          if (!m || m.movieFileId) continue;
          // Same two blind spots the episode path had: a movie whose grab is still
          // in flight (its pointer is only set by the import, so every feed item
          // until then saw it as missing) and one whose file is in its folder with
          // the pointer lost. Both already have the movie; neither wants another.
          if (moviesInFlight.has(m.id)) continue;
          let hasFile = movieOnDisk.get(m.id);
          if (hasFile === undefined) {
            hasFile = (await movieFileOnDisk(m.id)) !== null;
            movieOnDisk.set(m.id, hasFile);
          }
          if (hasFile) continue;
          const profile = lib.profiles.get(m.qualityProfileId);
          if (!profile) continue;
          const evaluation = evaluate(candidate, {
            profile,
            targetTitles: [m.title],
            targetYear: m.year,
            currentQuality: null,
            minimumSeeders: indexer.minimumSeeders,
            mediaType: "movie",
          });
          if (!evaluation.accepted) continue;
          await grab({ ...candidate, ...evaluation }, { mediaType: "movie", movieId: m.id });
          moviesInFlight.add(m.id); // later items in this same feed must not re-grab it
          grabbed++;
        }
      } catch (err) {
        console.warn(`[rss-sync] grab failed for '${item.title}':`, err);
      }
    }
  }

  return `${seen} releases seen, ${grabbed} grabbed`;
}
