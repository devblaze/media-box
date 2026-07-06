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

/**
 * The 3-state file-operations mode:
 *   - `allow` — moves/renames/deletes happen freely.
 *   - `ask`   — file changes are held as pending approvals (see file-change-service).
 *   - `off`   — never move/rename/delete (read-only mode; the guards below hard-block).
 * The "ask" gating lives at the operation sites, not here: `placeFile`/`removeMedia`
 * only ever hard-block on `off`, so an approved "ask" change (which runs in `ask`
 * mode) can still complete.
 */
export function fileOperationsMode(): "allow" | "ask" | "off" {
  return getSettings().fileOperationsMode;
}

/** True when media-box is allowed to move/rename/delete files (mode is not `off`). */
export function fileOperationsEnabled(): boolean {
  return fileOperationsMode() !== "off";
}

/** Throw `MediaWritesDisabledError` when file operations are disabled. */
export function assertFileOperationsEnabled(): void {
  if (!fileOperationsEnabled()) throw new MediaWritesDisabledError();
}
