import type { NextRequest } from "next/server";
import { z } from "zod";
import { auditLibraryOrdering } from "@/server/library/ordering-audit";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { requireAdmin } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

/**
 * Series whose episode files are numbered differently from the episodes they are
 * attached to — the signature of a library moved over from Sonarr, Jellyfin or
 * Plex, which all count TVDB's seasons while TMDB airs some shows (long-running
 * anime especially) as one huge season.
 *
 * Pure DB work, no TMDB calls, so it answers immediately even for a big library.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const findings = auditLibraryOrdering();
    return ok({
      count: findings.length,
      mismatchedFiles: findings.reduce((n, f) => n + f.mismatched, 0),
      findings,
    });
  } catch (err) {
    return serverError(err);
  }
}

const bodySchema = z.object({
  /** Limit the run to these series; omit to sweep the whole library. */
  seriesIds: z.array(z.number().int().positive()).optional(),
  /** Score and report without renumbering anything. */
  dryRun: z.boolean().optional(),
});

/**
 * Queue an `AlignSeasonOrdering` sweep: each candidate series is scored against
 * the season/episode numbers its own files use, and re-pointed at whichever TMDB
 * ordering explains them. Renumbering re-matches files from disk, so this runs
 * as a command; watch it on the Tasks page (its result carries the changes).
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({}));
    const { seriesIds, dryRun } = bodySchema.parse(body ?? {});
    const commandId = enqueueCommand(
      "AlignSeasonOrdering",
      { seriesIds, dryRun: dryRun ?? false },
      "manual",
      10
    );
    return ok({ queued: commandId !== null, commandId });
  } catch (err) {
    return serverError(err);
  }
}
