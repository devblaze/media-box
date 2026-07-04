import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { becauseYouWatched } from "@/server/metadata/recommendations";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Because you watched X" rows for the signed-in user, derived from their most
 * recent watched titles via TMDB recommendations. Empty array when there's no
 * watch history yet (the Discover page then renders no such rows).
 */
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    return ok(await becauseYouWatched(user.id));
  } catch (err) {
    return serverError(err);
  }
}
