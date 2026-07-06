import { NextResponse } from "next/server";
import { getRequestUser, type SessionUser } from "@/server/auth/auth-service";
import { principalHasPermission, type PermissionKey } from "@/lib/permissions";

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

/**
 * Authorize by capability: allow admins (super-admin) OR non-admins whose custom
 * role grants `permission`. Returns the denial response, or null when allowed.
 *
 *   const denied = requirePermission(request, "requests.approve");
 *   if (denied) return denied;
 */
export function requirePermission(request: Request, permission: PermissionKey): NextResponse | null {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!principalHasPermission(user, permission)) {
    return NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 });
  }
  return null;
}

/**
 * Like requirePermission but returns the authenticated user for handlers that
 * need the actor (e.g. to record who approved a request). Usage:
 *
 *   const actor = requirePermissionUser(request, "requests.approve");
 *   if (actor instanceof NextResponse) return actor;
 *   // ...use actor.id
 */
export function requirePermissionUser(
  request: Request,
  permission: PermissionKey
): SessionUser | NextResponse {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!principalHasPermission(user, permission)) {
    return NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 });
  }
  return user;
}

/** In-handler capability check for a user you've already resolved. */
export function hasPermission(user: SessionUser, permission: PermissionKey): boolean {
  return principalHasPermission(user, permission);
}
