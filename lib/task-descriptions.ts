/**
 * Human-readable "what does this do" copy for every scheduled task / background
 * command, keyed by its internal name (see `server/jobs/handlers/index.ts` and
 * `server/jobs/scheduler.ts`). Shown as a hover tooltip on the Tasks page.
 */
export const TASK_DESCRIPTIONS: Record<string, string> = {
  RssSync:
    "Polls your indexers' RSS feeds for newly-posted releases that match monitored movies and series, and grabs anything that fits their quality profile.",
  WantedSearch:
    "Searches your indexers for monitored movies and episodes that are still missing a file (the backlog) and grabs the best available release.",
  SubtitleSearch:
    "Searches your subtitle providers for missing subtitles in your configured languages and downloads them for your library.",
  QueueMonitor:
    "Polls your download clients (qBittorrent / TorBox) for progress, updates each download's status, and hands finished downloads off to be imported.",
  RefreshSeries:
    "Refreshes series metadata from TMDB — episode lists, air dates, status, and artwork.",
  RefreshMovies:
    "Refreshes movie metadata from TMDB — release dates, status, and artwork.",
  DiskScan:
    "Scans your library folders on disk for files added, moved, or removed outside media-box and reconciles them with the database.",
  Housekeeping:
    "Tidies the database: removes completed/failed command history older than a week and expired login sessions.",
  ChannelScheduler:
    "Keeps each Live TV channel's schedule filled ~12 hours ahead and grabs any missing upcoming programs.",
  LibraryImportBatch:
    "Processes a batch of existing files during a Library Import — matches each to TMDB and adds it to your library.",
  FetchTorboxFiles:
    "Downloads completed files from TorBox (cloud debrid) into the local staging folder so they can be imported.",
  ImportDownload:
    "Imports a finished download — moves and renames the file into your library and links it to the movie or episode.",
  ExecuteMigration:
    "Runs a data migration from another app (e.g. Sonarr, Radarr, or Bazarr) that you started importing.",
};

/** The description for a task/command name, or undefined if none is defined. */
export function taskDescription(name: string): string | undefined {
  return TASK_DESCRIPTIONS[name];
}
