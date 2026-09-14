import type { NextRequest } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { deleteBuild, getBuild } from "@/server/apps/app-registry";
import { notFound, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Remove a build and its file. */
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!getBuild(id)) return notFound("Build not found");
  deleteBuild(id);
  // A JSON body rather than a bare 204: the shared `apiFetch` always reads one,
  // and every other DELETE in this API answers the same way.
  return ok({ deleted: true });
}
