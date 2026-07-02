import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, authenticate, createSession } from "@/server/auth/auth-service";
import { serverError } from "@/lib/http";

const bodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const { username, password } = bodySchema.parse(await request.json());
    const user = authenticate(username, password);
    if (!user) {
      return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
    }
    const session = createSession(user.id);
    const res = NextResponse.json({ id: user.id, username: user.username, role: user.role });
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
