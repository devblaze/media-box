import type { NextRequest } from "next/server";
import { z } from "zod";
import { getCaps } from "@/server/indexers/torznab";
import { requirePermission } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

const bodySchema = z.object({
  url: z.string().url(),
  apiKey: z.string().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const { url, apiKey } = bodySchema.parse(await request.json());
    try {
      const caps = await getCaps(url, apiKey ?? null);
      return ok({
        ok: true,
        message: `OK — tv-search: ${caps.tvSearchAvailable ? "yes" : "no"}, movie-search: ${caps.movieSearchAvailable ? "yes" : "no"}, ${caps.categories.length} categories`,
        caps,
      });
    } catch (err) {
      return ok({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    return serverError(err);
  }
}
