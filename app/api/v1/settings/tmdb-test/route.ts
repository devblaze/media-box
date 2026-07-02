import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

const bodySchema = z.object({ tmdbApiKey: z.string().min(1) });

// Validates a TMDB API key with a live /configuration call.
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { tmdbApiKey } = bodySchema.parse(await request.json());
    const res = await fetch(
      `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(tmdbApiKey)}`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      return ok({ ok: false, message: `TMDB responded ${res.status}` });
    }
    return ok({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
