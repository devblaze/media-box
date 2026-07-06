import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { requireAdminUser } from "@/server/auth/guards";
import { roleExists } from "@/server/auth/role-service";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

const patchSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  // Custom role to assign (null clears it). Ignored/cleared when the user is admin.
  roleId: z.number().int().positive().nullable().optional(),
});

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/users/[id]">) {
  try {
    const actor = requireAdminUser(request);
    if (actor instanceof NextResponse) return actor;
    const { id } = await ctx.params;
    const userId = Number(id);
    if (!Number.isInteger(userId)) return badRequest("Invalid id");
    const input = patchSchema.parse(await request.json());

    const db = getDb();
    const existing = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!existing) return notFound("User not found");

    // The resulting role decides whether a custom role assignment is meaningful:
    // admins are super-admin and never carry a custom role.
    const nextRole = input.role ?? existing.role;
    let nextRoleId = input.roleId !== undefined ? input.roleId : existing.roleId;
    if (nextRole === "admin") nextRoleId = null;
    if (nextRoleId != null && !roleExists(nextRoleId)) return badRequest("Unknown role");

    // Don't let an admin strip their own admin rights and lock the panel out.
    if (userId === actor.id && nextRole !== "admin") {
      return badRequest("You can't remove your own admin access");
    }

    db.update(schema.users)
      .set({ role: nextRole, roleId: nextRoleId })
      .where(eq(schema.users.id, userId))
      .run();
    return ok({ updated: true });
  } catch (err) {
    return serverError(err);
  }
}

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
