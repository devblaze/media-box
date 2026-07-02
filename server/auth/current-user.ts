import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "@/server/auth/auth-service";

/**
 * Read the current user from the session cookie inside a Server Component /
 * layout / server action. `cookies()` is async in Next 16 and must be awaited.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return getSessionUser(store.get(SESSION_COOKIE)?.value);
}

/** Redirect to /login if signed out, or to / if not an admin. Returns the admin user otherwise. */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  return user;
}
