import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";
import { deleteRole, roleExists, updateRole } from "@/server/auth/role-service";
import { PERMISSION_KEYS } from "@/lib/permissions";

const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  permissions: z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).optional(),
});

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/roles/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const roleId = Number(id);
    if (!Number.isInteger(roleId)) return badRequest("Invalid id");
    if (!roleExists(roleId)) return notFound("Role not found");
    const input = patchSchema.parse(await request.json());
    try {
      updateRole(roleId, input);
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        return NextResponse.json({ error: "A role with that name already exists" }, { status: 409 });
      }
      throw e;
    }
    return ok({ updated: true });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/roles/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const roleId = Number(id);
    if (!Number.isInteger(roleId)) return badRequest("Invalid id");
    if (!roleExists(roleId)) return notFound("Role not found");
    deleteRole(roleId);
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
