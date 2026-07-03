import type { NextRequest } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { getNowAndNext, isChannel } from "@/server/channels/schedule";
import { ok, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ kind: string }> };

/** The program on now (with seek offset) plus the next few, for a channel. */
export async function GET(request: NextRequest, ctx: Ctx) {
  if (!getRequestUser(request)) return new Response("Unauthorized", { status: 401 });
  const { kind } = await ctx.params;
  if (!isChannel(kind)) return notFound("Unknown channel");
  return ok(getNowAndNext(kind, 6));
}
