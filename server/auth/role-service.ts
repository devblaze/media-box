import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { sanitizePermissions, type PermissionKey } from "@/lib/permissions";

export interface RoleRow {
  id: number;
  name: string;
  permissions: PermissionKey[];
  /** How many users are currently assigned this role. */
  userCount: number;
  createdAt: Date;
}

/** All roles, alphabetical, each with a live assigned-user count. */
export function listRoles(): RoleRow[] {
  const db = getDb();
  const roles = db.select().from(schema.roles).orderBy(asc(schema.roles.name)).all();
  const assigned = db.select({ roleId: schema.users.roleId }).from(schema.users).all();
  const counts = new Map<number, number>();
  for (const u of assigned) {
    if (u.roleId != null) counts.set(u.roleId, (counts.get(u.roleId) ?? 0) + 1);
  }
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    permissions: sanitizePermissions(r.permissions ?? []),
    userCount: counts.get(r.id) ?? 0,
    createdAt: r.createdAt,
  }));
}

export function createRole(name: string, permissions: readonly string[]): RoleRow {
  const row = getDb()
    .insert(schema.roles)
    .values({
      name: name.trim(),
      permissions: sanitizePermissions(permissions),
      createdAt: new Date(),
    })
    .returning()
    .get();
  return { ...row, permissions: sanitizePermissions(row.permissions ?? []), userCount: 0 };
}

export function updateRole(
  id: number,
  patch: { name?: string; permissions?: readonly string[] }
): boolean {
  const set: Partial<{ name: string; permissions: PermissionKey[] }> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.permissions !== undefined) set.permissions = sanitizePermissions(patch.permissions);
  if (Object.keys(set).length === 0) return roleExists(id);
  const res = getDb().update(schema.roles).set(set).where(eq(schema.roles.id, id)).run();
  return res.changes > 0;
}

/**
 * Delete a role, first clearing it from any users. We null the assignment in code
 * because the SQLite `ADD COLUMN` FK could not carry an `ON DELETE SET NULL`, so
 * deleting an in-use role would otherwise be blocked by the FK constraint.
 */
export function deleteRole(id: number): void {
  const db = getDb();
  db.update(schema.users).set({ roleId: null }).where(eq(schema.users.roleId, id)).run();
  db.delete(schema.roles).where(eq(schema.roles.id, id)).run();
}

export function roleExists(id: number): boolean {
  return !!getDb()
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.id, id))
    .get();
}
