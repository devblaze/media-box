import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseTitle } from "@/server/parser/release-parser";
import { isUpgrade, type ProfileLike } from "@/server/parser/scoring";
import { QUALITIES, type QualityModel } from "@/server/parser/quality";
import {
  renderEpisodeFilename,
  renderMovieFilename,
  renderSeasonFolder,
  type MultiEpisodeStyle,
} from "./naming";
import { applyOwnership, freeSpace, mkdirp, placeFile, removeMedia, type ImportMode } from "./filesystem";
import { fileOperationsEnabled, fileOperationsMode } from "./media-guard";
import { recordPendingFileChange } from "./file-change-service";
import { probeMediaInfo } from "./media-info";
import { VIDEO_EXTENSIONS } from "./disk-scanner";
import {
  episodeFilesOnDisk,
  movieFilesOnDisk,
  namesAnEpisode,
  resolveEpisodeRows,
  type FileOnDisk,
} from "./on-disk";
import { emitEvent } from "@/server/events/bus";
import { markRequestsAvailable } from "@/server/requests/request-service";
import { getSettings } from "@/server/settings/settings-service";
import { getClient } from "@/server/download/client";
import { recordDownloadFailure } from "@/server/download/failure-log";
import { recordLog } from "@/server/logging/logger";
import { enqueueCommand } from "@/server/jobs/scheduler";

type DownloadRow = typeof schema.downloads.$inferSelect;

class ImportWarning extends Error {}

/** Pixel height of a stored quality (0 when unknown) — for version detection. */
function resolutionOfQuality(q: QualityModel | null | undefined): number {
  return QUALITIES.find((d) => d.id === q?.qualityId)?.resolution ?? 0;
}

async function findVideoFiles(root: string): Promise<{ absPath: string; size: number }[]> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat) throw new ImportWarning(`Download path not found: ${root}`);
  if (stat.isFile()) {
    return VIDEO_EXTENSIONS.has(path.extname(root).toLowerCase())
      ? [{ absPath: root, size: stat.size }]
      : [];
  }
  const out: { absPath: string; size: number }[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findVideoFiles(abs)));
    } else if (
      VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      !/\bsample\b/i.test(entry.name)
    ) {
      const s = await fs.stat(abs);
      if (s.size > 20 * 1024 * 1024) out.push({ absPath: abs, size: s.size });
    }
  }
  return out;
}

function applyRemotePathMappings(clientId: number, remotePath: string): string {
  const db = getDb();
  const mappings = db
    .select()
    .from(schema.remotePathMappings)
    .where(eq(schema.remotePathMappings.downloadClientId, clientId))
    .all()
    .sort((a, b) => b.remotePath.length - a.remotePath.length); // longest prefix wins
  for (const m of mappings) {
    if (remotePath.startsWith(m.remotePath)) {
      return path.join(m.localPath, remotePath.slice(m.remotePath.length));
    }
  }
  return remotePath;
}

function getNaming() {
  const row = getDb().select().from(schema.namingConfig).get();
  if (!row) throw new Error("Naming config missing");
  return row;
}

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
  };
}

async function importEpisodes(
  download: DownloadRow,
  files: { absPath: string; size: number }[],
  mode: ImportMode
) {
  const db = getDb();
  const naming = getNaming();
  const s = db.select().from(schema.series).where(eq(schema.series.id, download.seriesId!)).get();
  if (!s) throw new ImportWarning("Series no longer in library");
  const profile = loadProfile(s.qualityProfileId);
  const targetEpisodeIds = (download.episodeIds as number[] | null) ?? [];
  const grabQuality = download.quality as QualityModel;

  const targetEpisodes =
    targetEpisodeIds.length > 0
      ? db
          .select()
          .from(schema.episodes)
          .where(
            and(
              eq(schema.episodes.seriesId, s.id),
              inArray(schema.episodes.id, targetEpisodeIds)
            )
          )
          .all()
      : [];
  /**
   * A single-file download grabbed FOR specific episodes is unambiguous: that
   * file IS those episodes, whatever the release calls itself. Anime make this
   * essential — "BLEACH Thousand Year Blood War S01E43" is the 43rd episode of a
   * sequel arc that no metadata source numbers as season 1, so parsing the name
   * points at the wrong episode (or none) and the import used to just fail.
   */
  const grabIsAuthoritative =
    files.length === 1 && targetEpisodes.length > 0 && targetEpisodes.length <= 2;
  /** Why each file was passed over — the first one explains a failed import. */
  const skipped: string[] = [];
  const codeOf = (ep: { seasonNumber: number; episodeNumber: number }) =>
    `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`;

  /**
   * What is actually in the series folder, built at most once per import and only
   * when an episode claims to have no file — a renumber drops the pointer without
   * touching disk, so "episodeFileId is null" is not the same as "nothing is there".
   */
  let diskMap: Map<number, FileOnDisk> | null = null;
  const filesOnDisk = async () => (diskMap ??= await episodeFilesOnDisk(s.id));

  let imported = 0;
  for (const file of files) {
    const name = path.basename(file.absPath);
    const parsed = parseTitle(name);
    // fall back to the release title for single-file torrents with useless inner names
    const effective =
      parsed.isTv && parsed.episodes.length > 0 ? parsed : parseTitle(download.title);
    // Anime fansub releases carry an absolute, whole-run number and no season
    // ("[SubsPlease] Bleach - 409"); those map through `episodes.absoluteNumber`,
    // as does an absolute number filed under a season that doesn't reach it
    // ("Bleach - S01E152"). `resolveEpisodeRows` owns both readings so the disk
    // check in on-disk.ts lands on exactly the episodes an import would.
    if (!namesAnEpisode(effective) && !grabIsAuthoritative) {
      skipped.push(`'${name}' doesn't name an episode`);
      if (files.length === 1) throw new ImportWarning(`Cannot map '${name}' to episodes`);
      continue;
    }

    let episodeRows = resolveEpisodeRows(s.id, s.isAnime, effective);
    // The release's own numbering has to agree with what this grab was for.
    // When it doesn't — or names nothing we recognise — a single-file grab falls
    // back to the episodes it was made for rather than failing the import.
    const onTarget =
      targetEpisodeIds.length === 0 || episodeRows.some((e) => targetEpisodeIds.includes(e.id));
    if (!onTarget || episodeRows.length === 0) {
      if (!grabIsAuthoritative) {
        skipped.push(
          episodeRows.length === 0
            ? `'${name}' names an episode this series doesn't have`
            : `'${name}' is ${episodeRows.map(codeOf).join("/")}, which this grab wasn't for`
        );
        continue;
      }
      recordLog(
        "info",
        `[import] '${name}'${
          episodeRows.length > 0 ? ` parses as ${episodeRows.map(codeOf).join("/")}` : " names no known episode"
        } — importing as ${targetEpisodes.map(codeOf).join("/")}, which it was grabbed for`,
        { source: "import", context: { downloadId: download.id, seriesId: s.id } }
      );
      episodeRows = targetEpisodes;
    }

    // Absolute-numbered releases have no season of their own — the matched rows do.
    const seasonNumber = episodeRows[0].seasonNumber;

    const quality = effective.quality.qualityId !== 0 ? effective.quality : grabQuality;

    // upgrade check against existing file (all mapped episodes share one file record)
    const existingFileId = episodeRows[0].episodeFileId;
    /** A file already on disk for this episode that no database row points at. */
    let orphan: FileOnDisk | null = null;
    let orphanIndex: Map<number, FileOnDisk> | null = null;
    if (existingFileId) {
      const existing = db
        .select()
        .from(schema.episodeFiles)
        .where(eq(schema.episodeFiles.id, existingFileId))
        .get();
      if (existing && !download.override && !isUpgrade(profile, quality, existing.quality as QualityModel)) {
        if (files.length === 1) throw new ImportWarning("Not an upgrade over the existing file");
        continue;
      }
    } else {
      // No pointer is not the same as no file: a renumber drops the link and
      // leaves the file where it was, so importing blind is what puts a second
      // copy of the episode in the library. An upgrade still imports — and takes
      // the stray file with it below — but a re-grab of the same thing stops here.
      const disk = await filesOnDisk();
      orphanIndex = disk;
      orphan = episodeRows.map((e) => disk.get(e.id)).find((f) => f !== undefined) ?? null;
      if (orphan && !download.override && !isUpgrade(profile, quality, orphan.quality)) {
        const reason = `'${path.basename(orphan.absPath)}' is already on disk for ${episodeRows
          .map(codeOf)
          .join("/")} and '${name}' isn't an upgrade over it`;
        if (files.length === 1) throw new ImportWarning(reason);
        skipped.push(reason);
        continue;
      }
    }

    const seasonFolder = s.seasonFolder
      ? renderSeasonFolder(naming.seasonFolderFormat, seasonNumber, {
          specialsFormat: naming.specialsFolderFormat,
        })
      : "";
    const sceneName = path.basename(file.absPath, path.extname(file.absPath));
    // Both arrays are read positionally by the renderer, so they are mapped from
    // one sorted list rather than sorted independently — an absolute number
    // against the wrong episode is exactly the kind of name that stops matching
    // after an ordering change.
    const orderedEpisodes = [...episodeRows].sort((a, b) => a.episodeNumber - b.episodeNumber);
    // renameEpisodes=false keeps the original release file name; otherwise render.
    const filename = naming.renameEpisodes
      ? renderEpisodeFilename(
          // Anime get their own format because the absolute number is what
          // survives a renumbering; season/episode coordinates do not.
          s.isAnime ? naming.animeEpisodeFormat : naming.standardEpisodeFormat,
          {
            seriesTitle: s.title,
            seriesYear: s.year,
            seasonNumber,
            episodeNumbers: orderedEpisodes.map((e) => e.episodeNumber),
            absoluteNumbers: orderedEpisodes.map((e) => e.absoluteNumber),
            episodeTitle: episodeRows[0].title,
            quality,
            releaseGroup: effective.releaseGroup,
            // The column is a plain text enum in SQLite; the renderer owns the
            // set of valid styles and falls back safely on anything else.
            multiEpisodeStyle: naming.multiEpisodeStyle as MultiEpisodeStyle,
          },
          { replaceIllegal: naming.replaceIllegalCharacters }
        )
      : sceneName;
    const destDir = path.join(s.path, seasonFolder);
    const dest = path.join(destDir, filename + path.extname(file.absPath));

    const createdDirs = await mkdirp(destDir);
    if ((await freeSpace(destDir)) < file.size + 100 * 1024 * 1024) {
      throw new ImportWarning("Not enough free space at destination");
    }
    const { method } = await placeFile(file.absPath, dest, mode);
    await applyOwnership(dest, createdDirs);

    // Best-effort technical metadata; never fails the import (returns null when
    // ffprobe is absent or errors).
    const mediaInfo = await probeMediaInfo(dest);

    const fileRow = db
      .insert(schema.episodeFiles)
      .values({
        seriesId: s.id,
        relativePath: path.relative(s.path, dest),
        size: file.size,
        quality,
        releaseGroup: effective.releaseGroup ?? null,
        sceneName,
        dateAdded: new Date(),
        mediaInfo,
      })
      .returning({ id: schema.episodeFiles.id })
      .get();

    // The copy the database had lost track of, superseded by what we just placed.
    // Same order and same guard as the replaced-file cleanup below: delete only
    // once the successor exists, and never when it IS the successor (a rename can
    // render the new file onto the stray one's exact path).
    if (orphan && path.resolve(orphan.absPath) !== path.resolve(dest)) {
      const record = db
        .select()
        .from(schema.episodeFiles)
        .where(
          and(
            eq(schema.episodeFiles.seriesId, s.id),
            eq(schema.episodeFiles.relativePath, path.relative(s.path, orphan.absPath))
          )
        )
        .get();
      // A file some OTHER episode still links is not ours to delete: a two-episode
      // file whose second half lost its pointer is still the first half's only copy.
      const stillLinked =
        record !== undefined &&
        db
          .select({ id: schema.episodes.id })
          .from(schema.episodes)
          .where(eq(schema.episodes.episodeFileId, record.id))
          .all().length > 0;
      if (!stillLinked) {
        await removeMedia(orphan.absPath);
        // The record can outlive the link (a refresh deletes the episode, not always
        // the row) — drop it too, so nothing is left pointing at a file that's gone.
        if (record) db.delete(schema.episodeFiles).where(eq(schema.episodeFiles.id, record.id)).run();
        // Keep the cached view honest for the rest of this (multi-file) import.
        for (const ep of episodeRows) orphanIndex?.delete(ep.id);
      }
    }

    for (const ep of episodeRows) {
      // delete a replaced file only after its successor is in place
      if (ep.episodeFileId && ep.episodeFileId !== fileRow.id) {
        const old = db
          .select()
          .from(schema.episodeFiles)
          .where(eq(schema.episodeFiles.id, ep.episodeFileId))
          .get();
        if (old) {
          const oldPath = path.join(s.path, old.relativePath);
          // Don't delete the file we just placed when the replacement renders to
          // the same path (e.g. a same-quality override re-import).
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
          sourceTitle: download.title,
          quality,
          downloadClientId: download.downloadClientId,
          downloadExternalId: download.externalId,
          data: { importMethod: method, path: dest },
          date: new Date(),
        })
        .run();
    }
    imported++;
    emitEvent({ type: "series.updated", seriesId: s.id });
  }

  if (imported === 0) {
    // Say WHICH file and WHY — "nothing matched" leaves nothing to act on.
    throw new ImportWarning(
      skipped.length > 0
        ? `Nothing imported: ${skipped[0]}${skipped.length > 1 ? ` (+${skipped.length - 1} more)` : ""}`
        : "No importable video files matched the target episodes"
    );
  }
  markRequestsAvailable("series", s.id);
  // Fetch subtitles for what just landed — but skip anime (usually has embedded
  // subs; the user triggers those manually).
  if (!s.isAnime) enqueueCommand("SubtitleSearch", { seriesId: s.id }, "system");
  return imported;
}

async function importMovie(
  download: DownloadRow,
  files: { absPath: string; size: number }[],
  mode: ImportMode
) {
  const db = getDb();
  const naming = getNaming();
  const m = db.select().from(schema.movies).where(eq(schema.movies.id, download.movieId!)).get();
  if (!m) throw new ImportWarning("Movie no longer in library");
  const profile = loadProfile(m.qualityProfileId);

  const best = files.sort((a, b) => b.size - a.size)[0];
  if (!best) throw new ImportWarning("No video file found in download");

  const parsed = parseTitle(path.basename(best.absPath));
  const quality =
    parsed.quality.qualityId !== 0 ? parsed.quality : (download.quality as QualityModel);

  // Whether the existing file is KEPT as another quality version instead of
  // replaced. A manual override always keeps it; a DIFFERENT-resolution
  // non-upgrade auto-versions too (grabbing a 4K next to a 1080p — or a lighter
  // 720p next to a 4K — is a deliberate additional version, not a duplicate).
  let keepOldAsVersion = download.override;
  if (m.movieFileId && !download.override) {
    const existing = db
      .select()
      .from(schema.movieFiles)
      .where(eq(schema.movieFiles.id, m.movieFileId))
      .get();
    if (existing && !isUpgrade(profile, quality, existing.quality as QualityModel)) {
      const oldRes = resolutionOfQuality(existing.quality as QualityModel);
      const newRes = resolutionOfQuality(quality);
      if (oldRes > 0 && newRes > 0 && oldRes !== newRes) {
        keepOldAsVersion = true;
      } else {
        throw new ImportWarning("Not an upgrade over the existing file");
      }
    }
  }

  /**
   * A file in the movie folder that no `movieFiles` row points at — a rolled-back
   * import, a folder moved in under an existing movie — is invisible to the check
   * above, so the grab that follows drops a second copy beside it.
   *
   * Only a file at the SAME resolution counts as that duplicate. The others are
   * the multi-version library working as designed (a 4K kept next to a 1080p, see
   * `addMovieFileVersion`), and nothing here may touch them.
   */
  const registered = new Set(
    db
      .select({ relativePath: schema.movieFiles.relativePath })
      .from(schema.movieFiles)
      .where(eq(schema.movieFiles.movieId, m.id))
      .all()
      .map((r) => path.resolve(m.path, r.relativePath))
  );
  const newResolution = resolutionOfQuality(quality);
  const orphan =
    (await movieFilesOnDisk(m.id)).find(
      (f) =>
        !registered.has(path.resolve(f.absPath)) && resolutionOfQuality(f.quality) === newResolution
    ) ?? null;
  if (orphan && !download.override && !isUpgrade(profile, quality, orphan.quality)) {
    throw new ImportWarning(
      `'${path.basename(orphan.absPath)}' is already on disk at the same resolution and this isn't an upgrade over it`
    );
  }

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
  const dest = path.join(m.path, filename + path.extname(best.absPath));

  const createdDirs = await mkdirp(m.path);
  if ((await freeSpace(m.path)) < best.size + 100 * 1024 * 1024) {
    throw new ImportWarning("Not enough free space at destination");
  }
  const { method } = await placeFile(best.absPath, dest, mode);
  await applyOwnership(dest, createdDirs);

  // Best-effort technical metadata; never fails the import (returns null when
  // ffprobe is absent or errors).
  const mediaInfo = await probeMediaInfo(dest);

  const oldFileId = m.movieFileId;
  const fileRow = db
    .insert(schema.movieFiles)
    .values({
      movieId: m.id,
      relativePath: path.relative(m.path, dest),
      size: best.size,
      quality,
      releaseGroup: parsed.releaseGroup ?? null,
      sceneName: path.basename(best.absPath, path.extname(best.absPath)),
      dateAdded: new Date(),
      mediaInfo,
    })
    .returning({ id: schema.movieFiles.id })
    .get();
  db.update(schema.movies).set({ movieFileId: fileRow.id }).where(eq(schema.movies.id, m.id)).run();

  // On a normal upgrade we replace: delete the old file. On a manual override —
  // or a different-resolution auto-version — we KEEP the old file as another
  // quality version (movieFiles allows several rows per movie); the
  // just-imported file becomes the primary movieFileId above.
  if (oldFileId && !keepOldAsVersion) {
    const old = db.select().from(schema.movieFiles).where(eq(schema.movieFiles.id, oldFileId)).get();
    if (old) {
      const oldPath = path.join(m.path, old.relativePath);
      if (path.resolve(oldPath) !== path.resolve(dest)) {
        await removeMedia(oldPath);
      }
      db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, oldFileId)).run();
    }
  }

  // The unregistered same-resolution copy this import supersedes — removed only
  // now that its replacement is in place, and never when it IS the replacement.
  if (orphan && path.resolve(orphan.absPath) !== path.resolve(dest)) {
    await removeMedia(orphan.absPath);
  }

  db.insert(schema.history)
    .values({
      eventType: "imported",
      mediaType: "movie",
      movieId: m.id,
      sourceTitle: download.title,
      quality,
      downloadClientId: download.downloadClientId,
      downloadExternalId: download.externalId,
      data: { importMethod: method, path: dest },
      date: new Date(),
    })
    .run();
  emitEvent({ type: "movie.updated", movieId: m.id });
  markRequestsAvailable("movie", m.id);
  // Fetch subtitles for the freshly-imported movie right away.
  enqueueCommand("SubtitleSearch", { movieId: m.id }, "system");
  return 1;
}

/**
 * After a successful import, remove the download from its client when the client
 * is configured with removeCompletedDownloads. Best-effort: never fails an
 * already-successful import. We pass deleteData=false so seeding source files are
 * left for the client to manage (move mode already relocated the source).
 *
 * TorBox additionally leaves its fetched copy in the local staging directory —
 * in copy/hardlink import mode that copy would otherwise linger forever, filling
 * the disk. Those files are media-box's own transient fetches (nothing seeds from
 * them), so the download's staging folder is always deleted after a successful
 * import, guarded to be strictly inside the configured staging dir.
 */
async function cleanupCompletedDownload(download: DownloadRow): Promise<void> {
  const db = getDb();
  const clientRow = db
    .select()
    .from(schema.downloadClients)
    .where(eq(schema.downloadClients.id, download.downloadClientId))
    .get();
  if (!clientRow) return;

  // Local TorBox staging leftovers — remove our fetched copy now that it's imported.
  if (clientRow.type === "torbox" && download.outputPath) {
    try {
      const stagingDir = String(
        (clientRow.settings as { stagingDir?: string } | null)?.stagingDir ?? ""
      );
      const staged = path.resolve(download.outputPath);
      // Only ever delete a path strictly INSIDE the staging dir (never the dir
      // itself, never anything outside it — e.g. a remapped library path).
      if (
        stagingDir &&
        staged !== path.resolve(stagingDir) &&
        staged.startsWith(path.resolve(stagingDir) + path.sep)
      ) {
        await fs.rm(staged, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(
        `[import] staging cleanup of '${download.title}' failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Remove from the client (TorBox cloud / qBittorrent) when configured to.
  if (!clientRow.removeCompletedDownloads) return;
  try {
    const client = await getClient(clientRow);
    await client.remove(download.externalId, false);
  } catch (err) {
    console.warn(
      `[import] cleanup of '${download.title}' from client failed:`,
      err instanceof Error ? err.message : err
    );
  }
}

export async function importDownload(
  downloadId: number,
  opts: { bypassHold?: boolean } = {}
): Promise<string> {
  const db = getDb();
  const download = db
    .select()
    .from(schema.downloads)
    .where(eq(schema.downloads.id, downloadId))
    .get();
  if (!download) throw new Error(`Download ${downloadId} not found`);
  if (!download.outputPath) throw new Error(`Download ${downloadId} has no output path yet`);

  // Read-only mode: don't touch files and don't record a failure. Leave the
  // download in an active state so QueueMonitor re-imports it once file
  // operations are turned back on.
  if (!fileOperationsEnabled()) {
    db.update(schema.downloads)
      .set({
        status: "downloading",
        statusMessage: "File operations are disabled — this download will import when you re-enable them.",
      })
      .where(eq(schema.downloads.id, downloadId))
      .run();
    emitEvent({ type: "queue.updated" });
    return `file operations disabled — deferred import of '${download.title}'`;
  }

  // Ask mode: hold the import for an approver instead of importing now. Park the
  // download in `importPending` (with an explanatory message) so QueueMonitor's
  // "already importing" guard stops it from re-enqueuing another import, and
  // record a pending file change the approver acts on. `bypassHold` is set when
  // the approval re-runs this to actually import.
  if (!opts.bypassHold && fileOperationsMode() === "ask") {
    recordPendingFileChange("import", `Import “${download.title}”`, download.outputPath, {
      downloadId,
    });
    db.update(schema.downloads)
      .set({
        status: "importPending",
        statusMessage: "Waiting for approval — file operations are in Ask mode.",
      })
      .where(eq(schema.downloads.id, downloadId))
      .run();
    emitEvent({ type: "queue.updated" });
    return `held import of '${download.title}' for approval`;
  }

  db.update(schema.downloads)
    .set({ status: "importing", statusMessage: null })
    .where(eq(schema.downloads.id, downloadId))
    .run();
  emitEvent({ type: "queue.updated" });

  try {
    const mode = getSettings().importMode;
    const localPath = applyRemotePathMappings(download.downloadClientId, download.outputPath);
    const files = await findVideoFiles(localPath);
    const count =
      download.mediaType === "movie"
        ? await importMovie(download, files, mode)
        : await importEpisodes(download, files, mode);

    db.update(schema.downloads)
      .set({ status: "imported", completedAt: new Date() })
      .where(eq(schema.downloads.id, downloadId))
      .run();
    emitEvent({ type: "queue.updated" });
    emitEvent({ type: "history.added" });

    // Success breadcrumb for the admin Logs page (the catch below logs failures).
    recordLog("info", `[import] imported ${count} file(s) from '${download.title}'`, {
      source: "import",
      context: {
        downloadId,
        files: count,
        mediaType: download.mediaType,
        outputPath: download.outputPath,
      },
    });

    await cleanupCompletedDownload(download);
    return `imported ${count} file(s) from '${download.title}'`;
  } catch (err) {
    const warning = err instanceof ImportWarning;
    const reason = err instanceof Error ? err.message : String(err);
    db.update(schema.downloads)
      .set({ status: warning ? "warning" : "failed", statusMessage: reason })
      .where(eq(schema.downloads.id, downloadId))
      .run();
    // Record hard import failures (not the expected "not an upgrade" warnings) so
    // the admin failures calendar can surface + let the admin re-search them.
    if (!warning) {
      recordDownloadFailure({
        mediaType: download.mediaType,
        seriesId: download.seriesId,
        movieId: download.movieId,
        episodeIds: download.episodeIds as number[] | null,
        sourceTitle: download.title,
        quality: download.quality as QualityModel | null,
        indexerId: download.indexerId,
        downloadClientId: download.downloadClientId,
        downloadExternalId: download.externalId,
        reason,
        stage: "import",
      });
    }
    emitEvent({ type: "queue.updated" });
    throw err;
  }
}
