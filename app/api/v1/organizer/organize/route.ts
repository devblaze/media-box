import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { organizeFile } from "@/server/library/organizer-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const organizeSchema = z.object({
  sourcePath: z.string().min(1),
  kind: z.enum(["series", "anime", "movie"]),
  id: z.number().int().positive(),
  seasonNumber: z.number().int().min(0).optional(),
  episodeNumbers: z.array(z.number().int().positive()).optional(),
});

/**
 * Organize a single loose file into the library at an explicit target (mirrors
 * the importer: place file + register file row + link episode/movie + log).
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let input: z.infer<typeof organizeSchema>;
  try {
    input = organizeSchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  try {
    const result = await organizeFile(input.sourcePath, {
      kind: input.kind,
      id: input.id,
      seasonNumber: input.seasonNumber,
      episodeNumbers: input.episodeNumbers,
    });
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
