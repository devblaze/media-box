import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseTitle } from "@/server/parser/release-parser";
import { isUpgrade, type ProfileLike } from "@/server/parser/scoring";
import type { QualityModel } from "@/server/parser/quality";
import { renderEpisodeFilename, renderMovieFilename, renderSeasonFolder } from "./naming";
import { applyOwnership, freeSpace, mkdirp, placeFile, removeMedia, type ImportMode } from "./filesystem";
import { fileOperationsEnabled, fileOperationsMode } from "./media-guard";
import { recordPendingFileChange } from "./file-change-service";
import { probeMediaInfo } from "./media-info";
import { VIDEO_EXTENSIONS } from "./disk-scanner";
import { emitEvent } from "@/server/events/bus";
import { markRequestsAvailable } from "@/server/requests/request-service";
import { getSettings } from "@/server/settings/settings-service";
import { getClient } from "@/server/download/client";
import { recordDownloadFailure } from "@/server/download/failure-log";
import { enqueueCommand } from "@/server/jobs/scheduler";

type DownloadRow = typeof schema.downloads.$inferSelect;

class ImportWarning extends Error {}

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

  let imported = 0;
  for (const file of files) {
    const parsed = parseTitle(path.basename(file.absPath));
    // fall back to the release title for single-file torrents with useless inner names
    const effective =
      parsed.isTv && parsed.episodes.length > 0 ? parsed : parseTitle(download.title);
    if (!effective.isTv || effective.seasons.length !== 1 || effective.episodes.length === 0) {
      if (files.length === 1) {
        throw new ImportWarning(`Cannot map '${path.basename(file.absPath)}' to episodes`);
      }
      continue;
    }

    const seasonNumber = effective.seasons[0];
    const episodeRows = db
      .select()
      .from(schema.episodes)
      .where(
        and(
          eq(schema.episodes.seriesId, s.id),
          eq(schema.episodes.seasonNumber, seasonNumber),
          inArray(schema.episodes.episodeNumber, effective.episodes)
        )
      )
      .all();
    if (episodeRows.length === 0) continue;

    // if the grab was for specific episodes, sanity-check overlap
    if (targetEpisodeIds.length > 0 && !episodeRows.some((e) => targetEpisodeIds.includes(e.id))) {
      continue;
    }

    const quality = effective.quality.qualityId !== 0 ? effective.quality : grabQuality;

    // upgrade check against existing file (all mapped episodes share one file record)
    const existingFileId = episodeRows[0].episodeFileId;
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
    }

    const seasonFolder = s.seasonFolder
      ? renderSeasonFolder(naming.seasonFolderFormat, seasonNumber)
      : "";
    const sceneName = path.basename(file.absPath, path.extname(file.absPath));
    // renameEpisodes=false keeps the original release file name; otherwise render.
    const filename = naming.renameEpisodes
      ? renderEpisodeFilename(
          naming.standardEpisodeFormat,
          {
            seriesTitle: s.title,
            seriesYear: s.year,
            seasonNumber,
            episodeNumbers: episodeRows.map((e) => e.episodeNumber).sort((a, b) => a - b),
            episodeTitle: episodeRows[0].title,
            quality,
            releaseGroup: effective.releaseGroup,
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

  if (imported === 0) throw new ImportWarning("No importable video files matched the target episodes");
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

  if (m.movieFileId && !download.override) {
    const existing = db
      .select()
      .from(schema.movieFiles)
      .where(eq(schema.movieFiles.id, m.movieFileId))
      .get();
    if (existing && !isUpgrade(profile, quality, existing.quality as QualityModel)) {
      throw new ImportWarning("Not an upgrade over the existing file");
    }
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

  // On a normal upgrade we replace: delete the old file. On a manual override we
  // KEEP the old file as another quality version (movieFiles allows several rows
  // per movie); the just-imported file becomes the primary movieFileId above.
  if (oldFileId && !download.override) {
    const old = db.select().from(schema.movieFiles).where(eq(schema.movieFiles.id, oldFileId)).get();
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
