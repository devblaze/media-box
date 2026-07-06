/**
 * The catalog of granular capabilities a custom role can grant to a non-admin
 * user. Shared by client and server — the server enforces them in route guards
 * (`server/auth/guards.ts`), the client uses them to show/hide controls, and the
 * Roles admin UI renders one toggle per entry.
 *
 * The built-in super-admin (`role === "admin"`) implicitly has all of these and
 * bypasses every check, so admins are never listed against individual permissions.
 */
export const PERMISSIONS = [
  {
    key: "requests.approve",
    label: "Approve / decline requests",
    description: "Review and approve or decline other users' media requests.",
  },
  {
    key: "releases.search",
    label: "Interactive search & grab",
    description:
      "Manually search indexers and grab or override a release when the automatic search misses.",
  },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

/** All permission keys, for validation and to grant the full set to admins. */
export const PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

/** Narrow an arbitrary string to a known permission key. */
export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as string[]).includes(value);
}

/** Keep only recognised permission keys (drops unknowns, de-dupes). */
export function sanitizePermissions(values: readonly string[]): PermissionKey[] {
  return PERMISSION_KEYS.filter((k) => values.includes(k));
}

/**
 * Does this principal hold a permission? Admins (super-admin) always do. Plain
 * users hold whatever their assigned role grants. Works with any object exposing
 * `role` and a resolved `permissions` list (SessionUser on the server, the
 * `/auth/me` payload on the client).
 */
export function principalHasPermission(
  principal: { role: string; permissions?: readonly string[] | null } | null | undefined,
  permission: PermissionKey
): boolean {
  if (!principal) return false;
  if (principal.role === "admin") return true;
  return !!principal.permissions?.includes(permission);
}
