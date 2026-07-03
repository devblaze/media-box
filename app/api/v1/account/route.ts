import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getRequestUser } from "@/server/auth/auth-service";
import { getSettings } from "@/server/settings/settings-service";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in user's own account settings (username, role, Pushover key). */
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    const row = getDb()
      .select({
        username: schema.users.username,
        role: schema.users.role,
        pushoverUserKey: schema.users.pushoverUserKey,
      })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .get();
    // pushoverConfigured tells the UI whether the admin has set the app token.
    return ok({ ...row, pushoverConfigured: !!getSettings().pushoverAppToken });
  } catch (err) {
    return serverError(err);
  }
}

const putSchema = z.object({ pushoverUserKey: z.string().max(64).optional() });

export async function PUT(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    const body = putSchema.parse(await request.json());
    getDb()
      .update(schema.users)
      .set({ pushoverUserKey: (body.pushoverUserKey ?? "").trim() || null })
      .where(eq(schema.users.id, user.id))
      .run();
    return ok({ saved: true });
  } catch (err) {
    return serverError(err);
  }
}
