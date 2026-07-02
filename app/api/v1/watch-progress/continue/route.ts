import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { continueWatching } from "@/server/playback/watch-progress-service";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** In-progress movies + the next episode to watch per started series. */
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    return ok(continueWatching(user.id));
  } catch (err) {
    return serverError(err);
  }
}
