import { getDb, schema } from "@/server/db";
import { adoptCandidate, type AdoptOutcome } from "@/server/library/adopt";
import { combineHints, loadJellyfinIndex } from "@/server/library/id-hints";
import { scanLibrary, type ImportType } from "@/server/library/library-import";
import { recordLog } from "@/server/logging/logger";

/**
 * Keep the library in step with what is actually on disk.
 *
 * Titles reach media-box's database by being added, migrated, or imported by
 * hand; anything that only ever arrived on disk — dropped in by another tool,
 * imported into Jellyfin but never here — stayed invisible: Discover offered to
 * request it, and nothing could play it. This walks every root folder, and every
 * title it can identify EXACTLY — by the ids Jellyfin matched, an .nfo beside
 * it, or an id in its folder name — joins the library with its files linked.
 * Titles with no id are left to Library Import, where a person confirms the
 * guess: a wrong title added automatically would be worse than a missing one.
 *
 * What it adds is unmonitored, so syncing never starts a download.
 */
export async function librarySyncHandler(): Promise<string> {
  const db = getDb();
  const roots = db.select().from(schema.rootFolders).all();
  if (roots.length === 0) return "no root folders configured";
  const profile = db.select({ id: schema.qualityProfiles.id }).from(schema.qualityProfiles).get();
  if (!profile) return "no quality profile configured";

  const jellyfin = await loadJellyfinIndex();
  const idHints = combineHints(jellyfin);

  const counts: Record<AdoptOutcome | "failed", number> = {
    added: 0,
    relinked: 0,
    version: 0,
    present: 0,
    failed: 0,
  };
  for (const root of roots) {
    const type: ImportType =
      root.mediaType === "movies" ? "movie" : root.mediaType === "anime" ? "anime" : "series";
    const { candidates } = await scanLibrary(type, root.path, {
      idHints,
      idsOnly: true,
      limit: Number.POSITIVE_INFINITY,
    });
    for (const c of candidates) {
      if (c.status !== "matched" || c.suggestedTmdbId == null) continue;
      try {
        const outcome = await adoptCandidate({
          mediaKind: c.mediaKind,
          type,
          tmdbId: c.suggestedTmdbId,
          path: c.path,
          videoPath: c.videoPath || null,
          rootFolderId: root.id,
          qualityProfileId: profile.id,
          monitored: false,
        });
        counts[outcome] += 1;
      } catch (err) {
        counts.failed += 1;
        recordLog("warn", `Library sync couldn't add '${c.name}'`, {
          source: "library",
          context: { path: c.path, tmdbId: c.suggestedTmdbId, error: String(err) },
        });
      }
    }
  }

  const source = jellyfin
    ? `Jellyfin (${jellyfin.size} names) + .nfo + folder ids`
    : ".nfo + folder ids";
  return (
    `added ${counts.added}, relinked ${counts.relinked} with missing files, ` +
    `${counts.version} extra versions, ${counts.failed} failed — identified by ${source}`
  );
}
