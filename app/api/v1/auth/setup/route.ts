import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  userCount,
} from "@/server/auth/auth-service";
import { badRequest, ok, serverError } from "@/lib/http";

const bodySchema = z.object({
  username: z.string().min(2).max(50),
  password: z.string().min(8).max(200),
});

// First-run: create the admin account. Only works while no users exist.
export async function POST(request: NextRequest) {
  try {
    if (userCount() > 0) return badRequest("Setup already completed");
    const { username, password } = bodySchema.parse(await request.json());
    const user = createUser(username, password, "admin");
    const session = createSession(user.id);
    const res = NextResponse.json(user, { status: 201 });
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

export async function GET() {
  try {
    return ok({ setupRequired: userCount() === 0 });
  } catch (err) {
    return serverError(err);
  }
}
