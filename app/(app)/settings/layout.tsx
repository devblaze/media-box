import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { principalHasPermission, SETTINGS_SECTION_PERMISSIONS } from "@/lib/permissions";

/**
 * Server-side guard for every /settings/* page. Admins see everything. A
 * non-admin may enter ONLY a section their role's permission unlocks (the
 * `SETTINGS_SECTION_PERMISSIONS` map — e.g. `monitoring.access` →
 * /settings/monitoring); every other settings page redirects them away before
 * it renders. The pathname arrives via the `x-pathname` header set by proxy.ts —
 * if it's ever missing, the guard falls back to admin-only (the safe default).
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "admin") return children;

  const path = (await headers()).get("x-pathname") ?? "";
  const section = Object.keys(SETTINGS_SECTION_PERMISSIONS).find(
    (p) => path === p || path.startsWith(`${p}/`)
  );
  if (section && principalHasPermission(user, SETTINGS_SECTION_PERMISSIONS[section])) {
    return children;
  }
  redirect("/");
}
