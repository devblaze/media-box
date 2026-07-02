import type { NextRequest } from "next/server";
import { z } from "zod";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";

// Coerce so string ids from the UI (route params) validate too.
const bodySchema = z.object({
  movieId: z.coerce.number().int().positive().optional(),
  episodeId: z.coerce.number().int().positive().optional(),
  seriesId: z.coerce.number().int().positive().optional(),
});

/**
 * Queue a subtitle search. With `movieId`/`episodeId`/`seriesId` it targets one
 * title (uncapped); with an empty body it queues the full backlog scan.
 */
export async function POST(request: NextRequest) {
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const payload = body.movieId || body.episodeId || body.seriesId ? body : {};
    enqueueCommand("SubtitleSearch", payload, "manual");
    return ok({ queued: true });
  } catch (err) {
    return serverError(err);
  }
}
