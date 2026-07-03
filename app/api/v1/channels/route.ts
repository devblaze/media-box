import type { NextRequest } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { CHANNELS, getNowAndNext } from "@/server/channels/schedule";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Landing summary: each channel with its current (and next-up) program. */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) return new Response("Unauthorized", { status: 401 });
  const channels = CHANNELS.map((channel) => {
    const { current, upNext, serverNow } = getNowAndNext(channel, 1);
    return { channel, serverNow, current, next: upNext[0] ?? null };
  });
  return ok({ channels });
}
