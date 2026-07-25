import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { ok } from "@/lib/http";
import { getOpenRouterModels } from "@/server/ai/openrouter-models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The OpenRouter model catalog for the settings picker (cached server-side for
 * an hour). Needs no OpenRouter API key — their /models endpoint is public.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return ok({ models: await getOpenRouterModels() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Could not load OpenRouter models: ${message}` }, { status: 502 });
  }
}
