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
        shareStreamingActivity: schema.users.shareStreamingActivity,
        seenStreamingHighlight: schema.users.seenStreamingHighlight,
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

const putSchema = z.object({
  pushoverUserKey: z.string().max(64).optional(),
  shareStreamingActivity: z.boolean().optional(),
  seenStreamingHighlight: z.boolean().optional(),
});

export async function PUT(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    const body = putSchema.parse(await request.json());
    // Only touch the fields the caller sent — the account page saves each card
    // (Pushover key, share toggle, the one-time highlight dismissal) on its own.
    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (body.pushoverUserKey !== undefined) {
      set.pushoverUserKey = body.pushoverUserKey.trim() || null;
    }
    if (body.shareStreamingActivity !== undefined) {
      set.shareStreamingActivity = body.shareStreamingActivity;
    }
    if (body.seenStreamingHighlight !== undefined) {
      set.seenStreamingHighlight = body.seenStreamingHighlight;
    }
    if (Object.keys(set).length > 0) {
      getDb().update(schema.users).set(set).where(eq(schema.users.id, user.id)).run();
    }
    return ok({ saved: true });
  } catch (err) {
    return serverError(err);
  }
}
