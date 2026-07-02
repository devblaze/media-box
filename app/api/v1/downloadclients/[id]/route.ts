import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { clientBodySchema } from "../route";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

// Secret fields arriving as the redaction placeholder keep their stored value.
function mergeSecrets(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...incoming };
  for (const key of ["password", "apiKey"]) {
    if (merged[key] === "••••••••") merged[key] = stored[key];
  }
  return merged;
}

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/downloadclients/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const clientId = Number(id);
    const db = getDb();
    const existing = db
      .select()
      .from(schema.downloadClients)
      .where(eq(schema.downloadClients.id, clientId))
      .get();
    if (!existing) return notFound("Download client not found");

    const body = (await request.json()) as Record<string, unknown>;
    if (body.settings && typeof body.settings === "object") {
      body.settings = mergeSecrets(
        existing.settings as Record<string, unknown>,
        body.settings as Record<string, unknown>
      );
    }
    const input = clientBodySchema.parse({ type: existing.type, ...body });
    db.update(schema.downloadClients)
      .set(input)
      .where(eq(schema.downloadClients.id, clientId))
      .run();
    return ok({ updated: true });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/downloadclients/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const clientId = Number(id);
    if (!Number.isInteger(clientId)) return badRequest("Invalid id");
    getDb().delete(schema.downloadClients).where(eq(schema.downloadClients.id, clientId)).run();
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
