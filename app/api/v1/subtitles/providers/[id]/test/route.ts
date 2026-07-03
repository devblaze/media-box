import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { providerById } from "@/server/subtitles/providers/registry";
import { getSettings } from "@/server/settings/settings-service";
import { ok, badRequest, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  title: z.string().optional(),
  year: z.coerce.number().int().optional(),
  language: z.string().optional(),
});

/**
 * Live-test a provider: run a real search for a well-known title (default
 * Inception 2010, which carries tmdb/imdb ids so API providers can match too) and
 * report how many results came back. Never 500s — reports { ok:false, error } so
 * the UI can show why a provider returned nothing.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/subtitles/providers/[id]/test">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const provider = providerById(id);
  if (!provider) return notFound("Unknown provider");
  if (!provider.isReady()) return badRequest(`${provider.name} is not configured`);

  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const language =
      body.language ||
      getSettings().subtitleLanguages.split(",").map((s) => s.trim()).filter(Boolean)[0] ||
      "en";
    // Default probe carries ids so OpenSubtitles.com (imdb/tmdb search) matches too.
    const q = body.title
      ? { language, title: body.title, year: body.year }
      : { language, title: "Inception", year: 2010, tmdbId: 27205, imdbId: "tt1375666" };

    const started = Date.now();
    const cands = await provider.search(q);
    return ok({
      ok: true,
      language,
      count: cands.length,
      tookMs: Date.now() - started,
      sample: cands.slice(0, 5).map((c) => ({ release: c.release, hearingImpaired: c.hearingImpaired })),
    });
  } catch (err) {
    return ok({ ok: false, count: 0, error: err instanceof Error ? err.message : "search failed" });
  }
}
