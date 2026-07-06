import type { NextRequest } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { getShareableStreams } from "@/server/users/user-activity-service";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Users streaming right now with "Share streaming activity" on — the joinable
 * hosts for the watch-together "Join" panel. Excludes the requesting user.
 */
export async function GET(request: NextRequest) {
  const me = getRequestUser(request);
  if (!me) return ok([]);
  try {
    const hosts = getShareableStreams()
      .filter((s) => s.userId !== me.id)
      .map((s) => ({
        userId: s.userId,
        username: s.username,
        title: s.stream.title,
        subtitle: s.stream.subtitle,
        poster: s.stream.poster,
        kind: s.stream.kind,
        target: {
          type: s.stream.kind,
          id: s.stream.kind === "movie" ? s.stream.movieId : s.stream.episodeId,
        },
      }))
      .filter((h) => h.target.id != null);
    return ok(hosts);
  } catch (err) {
    return serverError(err);
  }
}
