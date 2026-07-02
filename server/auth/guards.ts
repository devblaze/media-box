import { NextResponse } from "next/server";
import { getRequestUser, type SessionUser } from "@/server/auth/auth-service";

/**
 * Route-handler authorization guards.
 *
 * Each returns a `NextResponse` (the denial) when the request is not allowed,
 * or `null` when it is. Usage mirrors the existing pattern:
 *
 *   const denied = requireAdmin(request);
 *   if (denied) return denied;
 *
 * NOTE: proxy.ts only checks for the *presence* of a session cookie/api key and
 * cannot validate sessions (it runs in the proxy runtime with no DB access), so
 * real authorization MUST live here in the handlers.
 */

export function requireUser(request: Request): NextResponse | null {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  return null;
}

export function requireAdmin(request: Request): NextResponse | null {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return null;
}

/**
 * Like requireAdmin but returns the authenticated admin user for handlers that
 * need it (e.g. to record who performed an action). Usage:
 *
 *   const actor = requireAdminUser(request);
 *   if (actor instanceof NextResponse) return actor;
 *   // ...use actor.id
 */
export function requireAdminUser(request: Request): SessionUser | NextResponse {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return user;
}
