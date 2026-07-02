import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { recentlyWatched } from "@/server/playback/watch-progress-service";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recently finished movies + episodes (watched), newest first. */
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    return ok(recentlyWatched(user.id));
  } catch (err) {
    return serverError(err);
  }
}
