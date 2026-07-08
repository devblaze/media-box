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
const bulkSchema = z.object({
  items: z.array(itemSchema).min(1).max(500),
  // When a target movie/episode already has a file: replace it (default) or
  // skip that item and leave the existing file untouched.
  onExisting: z.enum(["replace", "skip"]).optional(),
});

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
    status: "organized" | "failed" | "skipped" | "held";
    detail?: string | null;
    destPath?: string;
    error?: string;
    id?: number;
  }> = [];
  let organized = 0;
  let failed = 0;
  let skipped = 0;
  let held = 0;

  for (const it of input.items) {
    try {
      const r = await organizeFile(
        it.sourcePath,
        {
          kind: it.kind,
          id: it.id,
          seasonNumber: it.seasonNumber,
          episodeNumbers: it.episodeNumbers,
        },
        { onExisting: input.onExisting }
      );
      // Ask mode: each organize is held for approval instead of performed now.
      if (r.status === "held") {
        held++;
        results.push({ sourcePath: it.sourcePath, status: "held", id: r.id });
        continue;
      }
      // Skip mode: target already had a file — nothing touched.
      if (r.status === "skipped") {
        skipped++;
        results.push({ sourcePath: it.sourcePath, status: "skipped", detail: r.reason });
        continue;
      }
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

  return ok({ organized, failed, skipped, held, results });
}
