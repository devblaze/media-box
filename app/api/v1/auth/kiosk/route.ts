import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, createSession, getOrCreateKioskUser } from "@/server/auth/auth-service";
import { getSettings } from "@/server/settings/settings-service";
import { serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ key: z.string().min(1) });

/**
 * Public kiosk/cast token exchange. A TV browser or Fully Kiosk tablet opening a
 * /tv/<channel>?key=... URL posts the shared kiosk token here; if it matches, we
 * mint a session for the low-privilege kiosk user and set the cookie, so every
 * downstream channel/stream/transcode request authenticates normally.
 */
export async function POST(request: NextRequest) {
  try {
    const { key } = bodySchema.parse(await request.json());
    const token = getSettings().kioskToken;
    if (!token || key !== token) {
      return NextResponse.json({ error: "Invalid or expired kiosk link" }, { status: 401 });
    }
    const session = createSession(getOrCreateKioskUser());
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });
    return res;
  } catch (err) {
    return serverError(err);
  }
}
