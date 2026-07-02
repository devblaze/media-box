import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { badRequest, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/rootfolders/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const folderId = Number(id);
    if (!Number.isInteger(folderId)) return badRequest("Invalid id");
    const db = getDb();
    const inUse = db
      .select({ id: schema.series.id })
      .from(schema.series)
      .where(eq(schema.series.rootFolderId, folderId))
      .get();
    const inUseMovie = db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(eq(schema.movies.rootFolderId, folderId))
      .get();
    if (inUse || inUseMovie) return badRequest("Root folder is in use by library items");
    db.delete(schema.rootFolders).where(eq(schema.rootFolders.id, folderId)).run();
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
