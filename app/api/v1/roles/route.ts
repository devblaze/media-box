import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { createRole, listRoles } from "@/server/auth/role-service";
import { PERMISSION_KEYS } from "@/lib/permissions";
import { ok, serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return ok(listRoles());
  } catch (err) {
    return serverError(err);
  }
}

const roleSchema = z.object({
  name: z.string().min(1).max(60),
  permissions: z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).default([]),
});

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const input = roleSchema.parse(await request.json());
    try {
      return ok(createRole(input.name, input.permissions), { status: 201 });
    } catch (e) {
      // Unique-name constraint (roles_name_unique).
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        return NextResponse.json({ error: "A role with that name already exists" }, { status: 409 });
      }
      throw e;
    }
  } catch (err) {
    return serverError(err);
  }
}
