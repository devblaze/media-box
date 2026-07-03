import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getRequestUser, verifyPassword, hashPassword } from "@/server/auth/auth-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

/** Change the signed-in user's own password (verifies the current password). */
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    const body = bodySchema.parse(await request.json());
    const db = getDb();
    const row = db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
    if (!row) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (!verifyPassword(body.currentPassword, row.passwordHash)) {
      return badRequest("Current password is incorrect");
    }
    db.update(schema.users)
      .set({ passwordHash: hashPassword(body.newPassword) })
      .where(eq(schema.users.id, user.id))
      .run();
    return ok({ changed: true });
  } catch (err) {
    return serverError(err);
  }
}
