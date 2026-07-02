import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { createUser } from "@/server/auth/auth-service";
import { requireAdmin } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const denied = requireAdmin(request);
    if (denied) return denied;
    const db = getDb();
    const rows = db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .orderBy(asc(schema.users.username))
      .all();
    return ok(rows);
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
