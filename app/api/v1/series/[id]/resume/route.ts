import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { seriesResume } from "@/server/playback/watch-progress-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the series-level Play button should do for the signed-in user: continue,
 * start from the first available episode, or start-from-available with the missing
 * earlier episodes listed (so the UI can offer to search + wait for them).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/series/[id]/resume">) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await ctx.params;
  const seriesId = Number(id);
  if (!Number.isInteger(seriesId)) return badRequest("Invalid id");
  try {
    return ok(seriesResume(user.id, seriesId));
  } catch (err) {
    return serverError(err);
  }
}
