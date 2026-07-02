import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdminUser } from "@/server/auth/guards";
import { badRequest, ok, serverError } from "@/lib/http";

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/users/[id]">) {
  try {
    const actor = requireAdminUser(request);
    if (actor instanceof NextResponse) return actor;
    const { id } = await ctx.params;
    const userId = Number(id);
    if (!Number.isInteger(userId)) return badRequest("Invalid id");
    if (userId === actor.id) return badRequest("Cannot delete your own account");
    getDb().delete(schema.users).where(eq(schema.users.id, userId)).run();
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
