import type { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/server/auth/guards";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ type: z.enum(["movie", "series", "anime"]) });

/**
 * Kick off the background batch import of every confidently-matched, not-yet-
 * imported candidate of `type`. Returns the command id immediately (does NOT
 * block): the work runs as a scheduler command so it survives navigation, and
 * the page tracks completion via `command.updated` events.
 */
export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "libraryImport.access");
  if (denied) return denied;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return badRequest("Body must be { type: 'movie' | 'series' | 'anime' }");
  }

  try {
    // enqueueCommand de-dupes an identical queued/started command → id is null then.
    const id = enqueueCommand("LibraryImportBatch", { type: body.type }, "manual", 10);
    return ok({ id, queued: id !== null }, { status: id === null ? 200 : 201 });
  } catch (err) {
    return serverError(err);
  }
}
