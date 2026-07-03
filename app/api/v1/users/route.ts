import type { NextRequest } from "next/server";
import { z } from "zod";
import { createUser } from "@/server/auth/auth-service";
import { requireAdmin } from "@/server/auth/guards";
import { listUsersWithActivity } from "@/server/users/user-activity-service";
import { ok, serverError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const denied = requireAdmin(request);
    if (denied) return denied;
    return ok(listUsersWithActivity());
  } catch (err) {
    return serverError(err);
  }
}

const addSchema = z.object({
  username: z.string().min(2).max(50),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "user"]).default("user"),
});

export async function POST(request: NextRequest) {
  try {
    const denied = requireAdmin(request);
    if (denied) return denied;
    const input = addSchema.parse(await request.json());
    const user = createUser(input.username, input.password, input.role);
    return ok(user, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
