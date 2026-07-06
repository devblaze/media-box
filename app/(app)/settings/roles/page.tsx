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
          <div className="flex flex-col gap-2">
            {PERMISSIONS.map((p) => (
              <label key={p.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={perms.includes(p.key)}
                  onChange={() => setPerms((cur) => toggle(cur, p.key))}
                />
                <span>
                  <span className="text-zinc-100">{p.label}</span>
                  <span className="block text-xs text-zinc-500">{p.description}</span>
                </span>
              </label>
            ))}
          </div>
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
                  </div>
                  <Button variant="danger" size="sm" onClick={() => remove(role)}>
                    Delete
                  </Button>
                </div>
                <div className="flex flex-col gap-2">
                  {PERMISSIONS.map((p) => (
                    <label key={p.key} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={role.permissions.includes(p.key)}
                        onChange={() => savePermissions(role, toggle(role.permissions, p.key))}
                      />
                      <span>
                        <span className="text-zinc-100">{p.label}</span>
                        <span className="block text-xs text-zinc-500">{p.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </CardBody>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
