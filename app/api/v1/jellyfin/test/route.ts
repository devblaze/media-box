import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { ok, badRequest } from "@/lib/http";
import { getPublicSystemInfo, JellyfinError } from "@/server/jellyfin/jellyfin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z.object({ url: z.string().min(1) });

/** Admin "Test" for the Jellyfin URL — hits the public system-info endpoint. */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let input: z.infer<typeof testSchema>;
  try {
    input = testSchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  try {
    const info = await getPublicSystemInfo(input.url.trim());
    return ok({
      ok: true,
      serverName: info.ServerName ?? "Jellyfin",
      version: info.Version ?? null,
    });
  } catch (err) {
    const message =
      err instanceof JellyfinError ? err.message : err instanceof Error ? err.message : String(err);
    return ok({ ok: false, message });
  }
}
