import type { NextRequest } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { stopSession } from "@/server/transcode/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/** Tear down a transcode session (called by the player on modal close/unmount). */
export async function DELETE(request: NextRequest, ctx: Ctx): Promise<Response> {
  if (!getRequestUser(request)) return new Response("Unauthorized", { status: 401 });
  const { sessionId } = await ctx.params;
  stopSession(sessionId);
  return new Response(null, { status: 204 });
}
