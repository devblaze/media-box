import { getSettings } from "@/server/settings/settings-service";

/**
 * Global read-only guard for the media library.
 *
 * When the admin turns "Allow file operations" OFF (Settings → Media Management),
 * media-box must never move, rename, or delete files on disk. Every code path that
 * touches media funnels through the two choke points that consult this guard:
 *   - `placeFile()` in filesystem.ts (all hardlink/copy/move placement), and
 *   - `removeMedia()` in filesystem.ts (all media deletes).
 * Higher-level callers (importer, organizer, movie/series delete) also check it up
 * front so they abort BEFORE mutating the database, keeping DB and disk in sync.
 */

/** Thrown when a file operation is attempted while file operations are disabled. */
export class MediaWritesDisabledError extends Error {
  constructor(
    message = "File operations are disabled. Turn on “Allow file operations” in Settings → Media Management to move, rename, or delete files."
  ) {
    super(message);
    // Matched by name (not instanceof) in lib/http.ts so it maps to a clean 409
    // without that module having to import server-only DB code.
    this.name = "MediaWritesDisabledError";
  }
}

/** True when media-box is allowed to move/rename/delete files. Defaults to true. */
export function fileOperationsEnabled(): boolean {
  return getSettings().fileOperationsEnabled;
}

/** Throw `MediaWritesDisabledError` when file operations are disabled. */
export function assertFileOperationsEnabled(): void {
  if (!fileOperationsEnabled()) throw new MediaWritesDisabledError();
}
