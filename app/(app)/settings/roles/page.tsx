"use client";

import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Skeleton,
  useConfirm,
  useToast,
} from "@/components/ui";

interface Role {
  id: number;
  name: string;
  permissions: PermissionKey[];
  userCount: number;
  createdAt: number | string;
}

/** The permission catalog grouped by its category, preserving catalog order. */
const PERMISSION_GROUPS: [string, (typeof PERMISSIONS)[number][]][] = (() => {
  const groups = new Map<string, (typeof PERMISSIONS)[number][]>();
  for (const p of PERMISSIONS) {
    const list = groups.get(p.category) ?? [];
    list.push(p);
    groups.set(p.category, list);
  }
  return [...groups.entries()];
})();

/** Grouped permission checkboxes, shared by the create form and each role card. */
function PermissionPicker({
  selected,
  onToggle,
}: {
  selected: readonly PermissionKey[];
  onToggle: (key: PermissionKey) => void;
}) {
  return (
    <div className="space-y-3">
      {PERMISSION_GROUPS.map(([category, perms]) => (
        <div key={category}>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            {category}
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {perms.map((p) => (
              <label
                key={p.key}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-sm transition-colors hover:border-zinc-600"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected.includes(p.key)}
                  onChange={() => onToggle(p.key)}
                />
                <span>
                  <span className="text-zinc-100">{p.label}</span>
                  <span className="block text-xs text-zinc-500">{p.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RolesPage() {
  const { data: roles, mutate } = useApi<Role[]>("/roles");
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<PermissionKey[]>([]);
  const [creating, setCreating] = useState(false);

  function toggle(list: PermissionKey[], key: PermissionKey): PermissionKey[] {
    return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  }

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await apiFetch("/roles", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), permissions: perms }),
      });
      setName("");
      setPerms([]);
      await mutate();
      toast.success("Role created.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create role");
    } finally {
      setCreating(false);
    }
  }

  async function savePermissions(role: Role, next: PermissionKey[]) {
    try {
      await apiFetch(`/roles/${role.id}`, {
        method: "PUT",
        body: JSON.stringify({ permissions: next }),
      });
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update role");
    }
  }

  async function rename(role: Role, next: string) {
    const trimmed = next.trim();
    if (!trimmed || trimmed === role.name) return;
    try {
      await apiFetch(`/roles/${role.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: trimmed }),
      });
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to rename role");
    }
  }

  async function remove(role: Role) {
    const ok = await confirm({
      title: `Delete role "${role.name}"?`,
      message:
        role.userCount > 0
          ? `${role.userCount} user${role.userCount > 1 ? "s" : ""} will lose these permissions.`
          : "This role isn't assigned to anyone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/roles/${role.id}`, { method: "DELETE" });
      await mutate();
      toast.success("Role deleted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete role");
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">Roles</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Create roles that grant specific capabilities, then assign them to users on the{" "}
        <span className="text-zinc-300">Users</span> page. Administrators always have every
        permission — roles only add capabilities to ordinary users.
      </p>

      {/* Create */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle>New role</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Role name (e.g. Moderators)"
            className="max-w-sm"
          />
          <PermissionPicker
            selected={perms}
            onToggle={(key) => setPerms((cur) => toggle(cur, key))}
          />
          <div>
            <Button size="sm" onClick={create} loading={creating} disabled={!name.trim()}>
              Create role
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* List */}
      <div className="mt-6 space-y-3">
        {!roles ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : roles.length === 0 ? (
          <EmptyState
            title="No roles yet"
            description="Create a role above to start delegating permissions."
          />
        ) : (
          roles.map((role) => (
            <Card key={role.id}>
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Input
                      defaultValue={role.name}
                      onBlur={(e) => rename(role, e.target.value)}
                      className="max-w-xs font-medium"
                    />
                    <Badge tone="neutral">
                      {role.userCount} user{role.userCount === 1 ? "" : "s"}
                    </Badge>
                    <Badge tone={role.permissions.length > 0 ? "info" : "neutral"}>
                      {role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => remove(role)}>
                    Delete
                  </Button>
                </div>
                <PermissionPicker
                  selected={role.permissions}
                  onToggle={(key) => savePermissions(role, toggle(role.permissions, key))}
                />
              </CardBody>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
