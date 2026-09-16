import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/server/auth/guards";
import { organizeFile } from "@/server/library/organizer-service";
import { ok, invalidBody, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const organizeSchema = z.object({
  sourcePath: z.string().min(1),
  kind: z.enum(["series", "anime", "movie"]),
  id: z.number().int().positive(),
  seasonNumber: z.number().int().min(0).optional(),
  // min(0), not positive(): season 0 is already allowed, and specials are
  // numbered from 0 under some conventions. Rejecting E00 here failed the whole
  // request with nothing to say which field was at fault.
  episodeNumbers: z.array(z.number().int().min(0)).optional(),
  // When the target movie/episode already has a file: replace it (default),
  // skip and leave everything alone, or skip and delete the now-redundant
  // download — the last only once the library copy is confirmed on disk.
  onExisting: z.enum(["replace", "skip", "skipAndDelete"]).optional(),
});

/**
 * Organize a single loose file into the library at an explicit target (mirrors
 * the importer: place file + register file row + link episode/movie + log).
 */
export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "organizer.access");
  if (denied) return denied;

  let input: z.infer<typeof organizeSchema>;
  try {
    input = organizeSchema.parse(await request.json());
  } catch (err) {
    // Name the field: a bare "Invalid request body" left no way to tell which
    // of six fields was at fault.
    return invalidBody(err);
  }

  try {
    const result = await organizeFile(
      input.sourcePath,
      {
        kind: input.kind,
        id: input.id,
        seasonNumber: input.seasonNumber,
        episodeNumbers: input.episodeNumbers,
      },
      { onExisting: input.onExisting }
    );
    // Ask mode: the organize was held for approval rather than performed now.
    if (result.status === "held") return ok({ held: true, id: result.id });
    // Skip mode: the target already had a file — nothing was touched.
    if (result.status === "skipped") {
      return ok({ skipped: true, reason: result.reason, sourceDeleted: result.sourceDeleted });
    }
    return ok(result);
  } catch (err) {
    // Conflicts (already in library / not-in-library) surface as 409 so the UI
    // can dismiss the row without treating it as a hard error.
    if (err instanceof Error && /(already in the library|not in the library)/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return serverError(err);
  }
}
