import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseTitle } from "@/server/parser/release-parser";
import { evaluate, type EvaluationContext, type ReleaseCandidate } from "@/server/parser/scoring";
import type { ProfileLike } from "@/server/parser/scoring";
import { type TorznabQuery } from "./torznab";
import { queryIndexer } from "./query";

const TV_CATS = [5000, 5030, 5040];
const MOVIE_CATS = [2000, 2010, 2020, 2030, 2040, 2045, 2060];

export interface DecoratedRelease extends ReleaseCandidate {
  accepted: boolean;
  rejections: string[];
  score: number;
}

export interface SearchTarget {
  mediaType: "series" | "movie";
  profile: ProfileLike;
  targetTitles: string[];
  targetYear?: number | null;
  seasonNumber?: number;
  episodeNumbers?: number[];
  allowSeasonPack?: boolean;
  currentQuality?: EvaluationContext["currentQuality"];
  /** torznab text query, e.g. "Show Title" (season/ep go as params) */
  query: string;
  interactive: boolean;
}

function isBlocklisted(mediaType: "series" | "movie", title: string, infoHash?: string): boolean {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.blocklist)
    .where(and(eq(schema.blocklist.mediaType, mediaType)))
    .all();
  return rows.some(
    (b) => b.sourceTitle === title || (infoHash && b.infoHash && b.infoHash === infoHash)
  );
}

export async function searchReleases(target: SearchTarget): Promise<DecoratedRelease[]> {
  const db = getDb();
  const enabledFlag =
    target.interactive ? schema.indexers.enableInteractiveSearch : schema.indexers.enableAutomaticSearch;
  const indexerRows = db
    .select()
    .from(schema.indexers)
    .where(and(eq(schema.indexers.enabled, true), eq(enabledFlag, true)))
    .all()
    .filter((i) => (target.mediaType === "series" ? i.supportsTv : i.supportsMovies));

  const results = await Promise.allSettled(
    indexerRows.map(async (indexer) => {
      const configuredCats = (indexer.categories as number[]) ?? [];
      const wanted = target.mediaType === "series" ? TV_CATS : MOVIE_CATS;
      const cats = configuredCats.filter((c) =>
        wanted.some((w) => c >= w && c < w + 1000)
      );
      const query: TorznabQuery = {
        t: target.mediaType === "series" ? "tvsearch" : "movie",
        q: target.query,
        cat: cats.length ? cats : wanted,
      };
      if (target.seasonNumber !== undefined) query.season = target.seasonNumber;
      if (target.episodeNumbers?.length === 1) query.ep = target.episodeNumbers[0];
      try {
        const items = await queryIndexer(indexer, query);
        return { indexer, items };
      } catch (err) {
        // Tag the failure with the indexer name — allSettled otherwise only
        // surfaces the bare error, so the log can't say which indexer to fix
        // (e.g. a Torznab "201: Indexer is not configured" from one provider).
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`"${indexer.name}" — ${msg}`);
      }
    })
  );

  const candidates: ReleaseCandidate[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[release-search] indexer failed:", result.reason);
      continue;
    }
    const { indexer, items } = result.value;
    for (const item of items) {
      candidates.push({
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
        publishDate: item.publishDate,
        parsed: parseTitle(item.title),
      });
    }
  }

  // dedupe by infohash (fall back to normalized title+size)
  const seen = new Set<string>();
  const deduped = candidates.filter((c) => {
    const key = c.infoHash ?? `${c.parsed.normalizedTitle}|${c.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const indexerById = new Map(indexerRows.map((i) => [i.id, i]));
  const decorated = deduped.map((c) => {
    const evaluation = evaluate(c, {
      profile: target.profile,
      targetTitles: target.targetTitles,
      targetYear: target.targetYear,
      seasonNumber: target.seasonNumber,
      episodeNumbers: target.episodeNumbers,
      allowSeasonPack: target.allowSeasonPack,
      currentQuality: target.currentQuality,
      minimumSeeders: indexerById.get(c.indexerId)?.minimumSeeders ?? 1,
      isBlocklisted: isBlocklisted(target.mediaType, c.title, c.infoHash),
      mediaType: target.mediaType,
    });
    return { ...c, ...evaluation };
  });

  return decorated.sort((a, b) => {
    if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    const prioA = indexerById.get(a.indexerId)?.priority ?? 25;
    const prioB = indexerById.get(b.indexerId)?.priority ?? 25;
    return prioA - prioB;
  });
}
