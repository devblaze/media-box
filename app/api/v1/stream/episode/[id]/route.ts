import type { NextRequest } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { streamFile } from "@/server/library/file-stream";
import { resolveMediaPath } from "@/server/library/resolve-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function handle(request: NextRequest, ctx: Ctx, method: "GET" | "HEAD"): Promise<Response> {
  if (!getRequestUser(request)) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const resolved = resolveMediaPath("episode", Number(id));
  if (!resolved) return new Response("Not Found", { status: 404 });
  return streamFile(request, resolved.absPath, method);
}

export function GET(request: NextRequest, ctx: Ctx): Promise<Response> {
  return handle(request, ctx, "GET");
}

export function HEAD(request: NextRequest, ctx: Ctx): Promise<Response> {
  return handle(request, ctx, "HEAD");
}
