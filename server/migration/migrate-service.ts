import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import {
  arrGet,
  fieldValue,
  type ArrConnection,
  type ArrDownloadClient,
  type ArrIndexer,
  type ArrQualityProfile,
  type ArrRootFolder,
  type ArrSystemStatus,
  type RadarrMovie,
  type SonarrSeries,
} from "./arr-client";
import { mapProfile, type MappedProfile } from "./profile-mapping";
import { findByTvdbId, getMovie, getTv } from "@/server/metadata/tmdb";
import { mapMovie, mapSeries } from "@/server/metadata/tmdb-map";
import { syncSeasonsAndEpisodes } from "@/server/library/series-service";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { emitEvent } from "@/server/events/bus";

export type App = "sonarr" | "radarr";

export interface MigrationPreview {
  app: App;
  version: string;
  itemCount: number;
  /** How many of the items are already in the media-box library (skipped on migrate). */
  existingCount: number;
  /** New items that would actually be migrated (itemCount - existingCount). */
  newCount: number;
  items: {
    title: string;
    year: number | null;
    path: string;
    monitored: boolean;
    tmdbId: number | null;
    /** Already in the library (by TMDB id) — will be skipped. */
    exists: boolean;
  }[];
  profiles: { sourceId: number; sourceName: string; mapped: MappedProfile }[];
  rootFolders: string[];
  torznabIndexers: { name: string; url: string; hasApiKey: boolean }[];
  skippedIndexers: string[];
  qbittorrentClients: { name: string; host: string; port: number }[];
  skippedClients: string[];
}

export async function preview(app: App, conn: ArrConnection): Promise<MigrationPreview> {
  const status = await arrGet<ArrSystemStatus>(conn, "/system/status");
  const [profiles, rootFolders, indexers, clients] = await Promise.all([
    arrGet<ArrQualityProfile[]>(conn, "/qualityprofile"),
    arrGet<ArrRootFolder[]>(conn, "/rootfolder"),
    arrGet<ArrIndexer[]>(conn, "/indexer"),
    arrGet<ArrDownloadClient[]>(conn, "/downloadclient"),
  ]);

  const rawItems =
    app === "sonarr"
      ? (await arrGet<SonarrSeries[]>(conn, "/series")).map((s) => ({
          title: s.title,
          year: s.year ?? null,
          path: s.path,
          monitored: s.monitored,
          tmdbId: s.tmdbId ?? null,
        }))
      : (await arrGet<RadarrMovie[]>(conn, "/movie")).map((m) => ({
          title: m.title,
          year: m.year ?? null,
          path: m.path,
          monitored: m.monitored,
          tmdbId: m.tmdbId ?? null,
        }));

  // Flag items already in the library (by TMDB id) so the UI can show how many
  // will be skipped; the execute step dedupes on the same key.
  const db = getDb();
  const tmdbIds = rawItems.map((i) => i.tmdbId).filter((x): x is number => x != null);
  const existingIds = new Set<number>();
  if (tmdbIds.length) {
    const rows =
      app === "sonarr"
        ? db
            .select({ t: schema.series.tmdbId })
            .from(schema.series)
            .where(inArray(schema.series.tmdbId, tmdbIds))
            .all()
        : db
            .select({ t: schema.movies.tmdbId })
            .from(schema.movies)
            .where(inArray(schema.movies.tmdbId, tmdbIds))
            .all();
    for (const r of rows) existingIds.add(r.t);
  }
  const items = rawItems.map((i) => ({
    ...i,
    exists: i.tmdbId != null && existingIds.has(i.tmdbId),
  }));
  const existingCount = items.filter((i) => i.exists).length;

  const torznab = indexers.filter((i) => i.implementation === "Torznab");
  const qbit = clients.filter((c) => c.implementation === "QBittorrent");

  return {
    app,
    version: status.version,
    itemCount: items.length,
    existingCount,
    newCount: items.length - existingCount,
    items,
    profiles: profiles.map((p) => ({ sourceId: p.id, sourceName: p.name, mapped: mapProfile(p) })),
    rootFolders: rootFolders.map((r) => r.path),
    torznabIndexers: torznab.map((i) => ({
      name: i.name,
      url: String(fieldValue(i.fields, "baseUrl") ?? ""),
      hasApiKey: Boolean(fieldValue(i.fields, "apiKey")),
    })),
    skippedIndexers: indexers
      .filter((i) => i.implementation !== "Torznab")
      .map((i) => `${i.name} (${i.implementation})`),
    qbittorrentClients: qbit.map((c) => ({
      name: c.name,
      host: String(fieldValue(c.fields, "host") ?? ""),
      port: Number(fieldValue(c.fields, "port") ?? 8080),
    })),
    skippedClients: clients
      .filter((c) => c.implementation !== "QBittorrent")
      .map((c) => `${c.name} (${c.implementation})`),
  };
}

export interface MigrationDecisions {
  /** source profile id -> existing media-box profile id, or "create" */
  profileMap: Record<string, number | "create">;
  /** path prefix rewrites applied to item paths, longest-first */
  pathRewrites: { from: string; to: string }[];
  importIndexers: boolean;
  importClients: boolean;
  /** media-box root folder id to attach migrated items to (fallback) */
  rootFolderId: number;
  /**
   * Optional per-source-root override: Sonarr/Radarr root folder path ->
   * media-box root folder id. Applied per item by its source root path,
   * falling back to `rootFolderId`. Used e.g. to map `/tv/Anime` to the
   * media-box Anime root (which also flags the series as anime).
   */
  rootFolderMap?: Record<string, number>;
}

export interface MigrationPayload {
  app: App;
  conn: ArrConnection;
  decisions: MigrationDecisions;
}

function rewritePath(path: string, rewrites: { from: string; to: string }[]): string {
  const sorted = [...rewrites].sort((a, b) => b.from.length - a.from.length);
  for (const r of sorted) {
    if (r.from && path.startsWith(r.from)) return r.to + path.slice(r.from.length);
  }
  return path;
}

/**
 * Resolve the decided media-box profile id for a source profile.
 *
 * A "create" decision reuses an existing profile with the same name
 * (case-insensitive) when one exists instead of inserting a duplicate, so
 * re-running a migration is idempotent for profiles (no more duplicate "Any").
 */
function resolveProfiles(
  sourceProfiles: ArrQualityProfile[],
  decisions: MigrationDecisions
): Map<number, number> {
  const db = getDb();
  const result = new Map<number, number>();
  // Kept in sync with inserts below so several source profiles sharing a name
  // all collapse onto a single created row.
  const existing = db.select().from(schema.qualityProfiles).all();
  const fallback = existing[0];
  const findByName = (name: string) =>
    existing.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  for (const source of sourceProfiles) {
    const decision = decisions.profileMap[String(source.id)];
    if (typeof decision === "number") {
      result.set(source.id, decision);
    } else if (decision === "create") {
      const mapped = mapProfile(source);
      const match = findByName(mapped.name);
      if (match) {
        result.set(source.id, match.id);
        continue;
      }
      const row = db
        .insert(schema.qualityProfiles)
        .values({
          name: mapped.name,
          upgradeAllowed: mapped.upgradeAllowed,
          cutoffQualityId: mapped.cutoffQualityId,
          items: mapped.items,
        })
        .returning()
        .get();
      existing.push(row);
      result.set(source.id, row.id);
    } else {
      result.set(source.id, fallback.id);
    }
  }
  return result;
}

/**
 * Resolve the media-box root folder for an item by its source root path, and
 * whether that root is the anime type. Honours the per-source-root override map
 * (`rootFolderMap`), falling back to the single "attach to" root. The source
 * root is taken from `rootFolderPath` when the arr provides it, else derived by
 * longest-prefix match of the item path against the source root folder paths.
 */
function resolveItemRoot(
  itemPath: string,
  sourceRootPath: string | undefined,
  sourceRootPaths: string[],
  decisions: MigrationDecisions,
  animeRootIds: Set<number>
): { rootFolderId: number; isAnime: boolean } {
  let srcRoot = sourceRootPath;
  if (!srcRoot) {
    srcRoot = [...sourceRootPaths]
      .filter((p) => p && itemPath.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
  }
  const mapped = srcRoot ? decisions.rootFolderMap?.[srcRoot] : undefined;
  const rootFolderId = mapped ?? decisions.rootFolderId;
  return { rootFolderId, isAnime: animeRootIds.has(rootFolderId) };
}

async function importIndexersAndClients(conn: ArrConnection, decisions: MigrationDecisions) {
  const db = getDb();
  const summary: string[] = [];

  if (decisions.importIndexers) {
    const indexers = await arrGet<ArrIndexer[]>(conn, "/indexer");
    let added = 0;
    for (const ix of indexers.filter((i) => i.implementation === "Torznab")) {
      const url = String(fieldValue(ix.fields, "baseUrl") ?? "");
      if (!url) continue;
      const exists = db.select().from(schema.indexers).where(eq(schema.indexers.url, url)).get();
      if (exists) continue;
      db.insert(schema.indexers)
        .values({
          name: ix.name,
          url,
          apiKey: (fieldValue(ix.fields, "apiKey") as string | undefined) ?? null,
          enableRss: ix.enableRss,
          enableAutomaticSearch: ix.enableAutomaticSearch,
          enableInteractiveSearch: ix.enableInteractiveSearch,
          priority: ix.priority || 25,
        })
        .run();
      added++;
    }
    summary.push(`${added} indexers`);
  }

  if (decisions.importClients) {
    const clients = await arrGet<ArrDownloadClient[]>(conn, "/downloadclient");
    let added = 0;
    for (const c of clients.filter((c) => c.implementation === "QBittorrent")) {
      const host = String(fieldValue(c.fields, "host") ?? "");
      if (!host) continue;
      const exists = db
        .select()
        .from(schema.downloadClients)
        .where(eq(schema.downloadClients.name, c.name))
        .get();
      if (exists) continue;
      db.insert(schema.downloadClients)
        .values({
          name: c.name,
          type: "qbittorrent",
          settings: {
            host,
            port: Number(fieldValue(c.fields, "port") ?? 8080),
            useSsl: Boolean(fieldValue(c.fields, "useSsl") ?? false),
            username: String(fieldValue(c.fields, "username") ?? ""),
            password: String(fieldValue(c.fields, "password") ?? ""),
            category: "media-box",
          },
          enabled: c.enable,
          priority: c.priority || 1,
        })
        .run();
      added++;
    }
    summary.push(`${added} download clients`);
  }
  return summary;
}

export async function executeMigration(payload: MigrationPayload): Promise<string> {
  const db = getDb();
  const { app, conn, decisions } = payload;
  const sourceProfiles = await arrGet<ArrQualityProfile[]>(conn, "/qualityprofile");
  const profileIdMap = resolveProfiles(sourceProfiles, decisions);

  // Source root folder paths (for per-item root resolution) and the set of
  // media-box root ids that are the "anime" type (so we can flag isAnime).
  const sourceRootFolders = await arrGet<ArrRootFolder[]>(conn, "/rootfolder");
  const sourceRootPaths = sourceRootFolders.map((r) => r.path);
  const animeRootIds = new Set(
    db
      .select({ id: schema.rootFolders.id })
      .from(schema.rootFolders)
      .where(eq(schema.rootFolders.mediaType, "anime"))
      .all()
      .map((r) => r.id)
  );

  const summary: string[] = [];
  let added = 0;
  let skipped = 0;
  let failed = 0;

  if (app === "sonarr") {
    const seriesList = await arrGet<SonarrSeries[]>(conn, "/series");
    for (const src of seriesList) {
      try {
        // resolve TMDB id: Sonarr is TVDB-keyed
        let tmdbId = src.tmdbId;
        if (!tmdbId) {
          const found = await findByTvdbId(src.tvdbId);
          tmdbId = found.tv_results[0]?.id;
        }
        if (!tmdbId) {
          failed++;
          console.warn(`[migrate] no TMDB match for '${src.title}' (tvdb ${src.tvdbId})`);
          continue;
        }
        const exists = db
          .select({ id: schema.series.id })
          .from(schema.series)
          .where(eq(schema.series.tmdbId, tmdbId))
          .get();
        if (exists) {
          skipped++;
          continue;
        }

        const details = await getTv(tmdbId);
        const mapped = mapSeries(details);
        const { rootFolderId, isAnime } = resolveItemRoot(
          src.path,
          src.rootFolderPath,
          sourceRootPaths,
          decisions,
          animeRootIds
        );
        const row = db
          .insert(schema.series)
          .values({
            ...mapped,
            tvdbId: src.tvdbId,
            path: rewritePath(src.path, decisions.pathRewrites),
            rootFolderId,
            isAnime,
            qualityProfileId: profileIdMap.get(src.qualityProfileId) ?? 1,
            monitored: src.monitored,
            seasonFolder: src.seasonFolder,
            addedAt: new Date(),
            lastRefreshAt: new Date(),
          })
          .returning({ id: schema.series.id })
          .get();
        await syncSeasonsAndEpisodes(row.id, tmdbId, details.seasons);
        // apply per-season monitored flags from the source
        for (const season of src.seasons) {
          db.update(schema.seasons)
            .set({ monitored: season.monitored })
            .where(
              and(
                eq(schema.seasons.seriesId, row.id),
                eq(schema.seasons.seasonNumber, season.seasonNumber)
              )
            )
            .run();
        }
        added++;
        emitEvent({ type: "series.updated", seriesId: row.id });
        // Match + import the show's existing on-disk files (they're already sorted
        // in Sonarr) so the episodes are immediately watchable — no manual matching.
        enqueueCommand("DiskScan", { seriesId: row.id }, "system");
      } catch (err) {
        failed++;
        console.error(`[migrate] series '${src.title}' failed:`, err);
      }
    }
    summary.push(`${added} series added, ${skipped} already present, ${failed} failed`);
  } else {
    const movieList = await arrGet<RadarrMovie[]>(conn, "/movie");
    for (const src of movieList) {
      try {
        const exists = db
          .select({ id: schema.movies.id })
          .from(schema.movies)
          .where(eq(schema.movies.tmdbId, src.tmdbId))
          .get();
        if (exists) {
          skipped++;
          continue;
        }
        const details = await getMovie(src.tmdbId);
        const mapped = mapMovie(details);
        const { rootFolderId } = resolveItemRoot(
          src.path,
          src.rootFolderPath,
          sourceRootPaths,
          decisions,
          animeRootIds
        );
        const row = db
          .insert(schema.movies)
          .values({
            ...mapped,
            path: rewritePath(src.path, decisions.pathRewrites),
            rootFolderId,
            qualityProfileId: profileIdMap.get(src.qualityProfileId) ?? 1,
            monitored: src.monitored,
            minimumAvailability:
              src.minimumAvailability === "announced" || src.minimumAvailability === "inCinemas"
                ? src.minimumAvailability
                : "released",
            addedAt: new Date(),
            lastRefreshAt: new Date(),
          })
          .returning({ id: schema.movies.id })
          .get();
        added++;
        emitEvent({ type: "movie.updated", movieId: row.id });
        // Match + import the movie's existing on-disk file so it's watchable now.
        enqueueCommand("DiskScan", { movieId: row.id }, "system");
      } catch (err) {
        failed++;
        console.error(`[migrate] movie '${src.title}' failed:`, err);
      }
    }
    summary.push(`${added} movies added, ${skipped} already present, ${failed} failed`);
  }

  summary.push(...(await importIndexersAndClients(conn, decisions)));

  // discover files on disk for everything we just added
  enqueueCommand("DiskScan", null, "system");

  return summary.join("; ");
}
