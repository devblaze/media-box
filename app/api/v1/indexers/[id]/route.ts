import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { indexerSchema } from "../route";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/indexers/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const indexerId = Number(id);
    const db = getDb();
    const existing = db.select().from(schema.indexers).where(eq(schema.indexers.id, indexerId)).get();
    if (!existing) return notFound("Indexer not found");
    const patch = indexerSchema.partial().parse(await request.json());
    db.update(schema.indexers)
      .set({ ...patch, apiKey: patch.apiKey === undefined ? existing.apiKey : patch.apiKey })
      .where(eq(schema.indexers.id, indexerId))
      .run();
    return ok(db.select().from(schema.indexers).where(eq(schema.indexers.id, indexerId)).get());
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/indexers/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const indexerId = Number(id);
    if (!Number.isInteger(indexerId)) return badRequest("Invalid id");
    getDb().delete(schema.indexers).where(eq(schema.indexers.id, indexerId)).run();
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
