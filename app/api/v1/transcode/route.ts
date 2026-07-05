import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/server/auth/auth-service";
import { resolveMediaPath } from "@/server/library/resolve-media";
import {
  startSession,
  CapReachedError,
  FfmpegMissingError,
} from "@/server/transcode/session-manager";
import { ok, badRequest, notFound, serverError } from "@/lib/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  type: z.enum(["movie", "episode"]),
  id: z.coerce.number().int().positive(),
  fileId: z.coerce.number().int().positive().optional(),
  startSec: z.coerce.number().min(0).optional(),
  // 0-based audio-stream index to transcode (from /audio-tracks). Defaults to the
  // first track when omitted.
  audioTrack: z.coerce.number().int().min(0).optional(),
});

export async function POST(request: NextRequest) {
  if (!getRequestUser(request)) return new Response("Unauthorized", { status: 401 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  const resolved = resolveMediaPath(body.type, body.id, body.fileId);
  if (!resolved) return notFound("Media not found");

  try {
    const session = await startSession(resolved.absPath, {
      startSec: body.startSec,
      audioTrack: body.audioTrack,
    });
    return ok({
      sessionId: session.id,
      url: `/api/v1/transcode/${session.id}/index.m3u8`,
    });
  } catch (err) {
    if (err instanceof CapReachedError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof FfmpegMissingError) {
      return NextResponse.json({ error: "ffmpeg not available" }, { status: 503 });
    }
    return serverError(err);
  }
}
