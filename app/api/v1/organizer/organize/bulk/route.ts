import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { organizeFile } from "@/server/library/organizer-service";
import { ok, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const itemSchema = z.object({
  sourcePath: z.string().min(1),
  kind: z.enum(["series", "anime", "movie"]),
  id: z.number().int().positive(),
  seasonNumber: z.number().int().min(0).optional(),
  episodeNumbers: z.array(z.number().int().positive()).optional(),
});
const bulkSchema = z.object({ items: z.array(itemSchema).min(1).max(500) });

/**
 * Organize many files in one request — e.g. assign a batch of episodes to a
 * series (each with its own parsed season/episode). Each file is independent: a
 * per-file failure/skip doesn't abort the rest; results are returned per file.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let input: z.infer<typeof bulkSchema>;
  try {
    input = bulkSchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  const results: Array<{
    sourcePath: string;
    status: "organized" | "failed" | "skipped";
    detail?: string | null;
    destPath?: string;
    error?: string;
  }> = [];
  let organized = 0;
  let failed = 0;
  let skipped = 0;

  for (const it of input.items) {
    try {
      const r = await organizeFile(it.sourcePath, {
        kind: it.kind,
        id: it.id,
        seasonNumber: it.seasonNumber,
        episodeNumbers: it.episodeNumbers,
      });
      organized++;
      results.push({ sourcePath: it.sourcePath, status: "organized", detail: r.detail, destPath: r.destPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Already-/not-in-library conflicts are skips, not hard failures.
      if (/(already in the library|not in the library)/i.test(msg)) {
        skipped++;
        results.push({ sourcePath: it.sourcePath, status: "skipped", error: msg });
      } else {
        failed++;
        results.push({ sourcePath: it.sourcePath, status: "failed", error: msg });
      }
    }
  }

  return ok({ organized, failed, skipped, results });
}
