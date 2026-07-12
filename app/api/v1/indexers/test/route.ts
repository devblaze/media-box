import type { NextRequest } from "next/server";
import { z } from "zod";
import { getCaps } from "@/server/indexers/torznab";
import { getBuiltin } from "@/server/indexers/builtin/registry";
import { requirePermission } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

const bodySchema = z.object({
  type: z.enum(["torznab", "builtin"]).optional(),
  url: z.string().optional(),
  apiKey: z.string().nullable().optional(),
  definition: z.string().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await request.json());

    // Built-in: probe by fetching its recent feed (empty query = RSS mode).
    if (body.type === "builtin") {
      const def = getBuiltin(body.definition);
      if (!def) return ok({ ok: false, message: `Unknown built-in indexer '${body.definition}'` });
      try {
        const items = await def.search({ t: def.supportsMovies ? "movie" : "search", q: "", limit: 5 });
        return ok({ ok: true, message: `OK — ${def.name} reachable (${items.length} recent releases)` });
      } catch (err) {
        return ok({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Torznab: a valid URL is required.
    const parsedUrl = z.string().url().safeParse(body.url);
    if (!parsedUrl.success) return ok({ ok: false, message: "A valid Torznab URL is required" });
    try {
      const caps = await getCaps(parsedUrl.data, body.apiKey ?? null);
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
