"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { timeAgo } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  useConfirm,
  useToast,
} from "@/components/ui";

interface MediaView {
  kind: "movie" | "episode";
  title: string;
  subtitle: string | null;
  poster: string | null;
}
interface NowStreaming extends MediaView {
  progressPct: number;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}
interface LastWatched extends MediaView {
  watched: boolean;
  updatedAt: number;
}
interface UserActivity {
  id: number;
  username: string;
  role: "admin" | "user";
  roleId: number | null;
  roleName: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
  requestCount: number;
  nowStreaming: NowStreaming | null;
  lastWatched: LastWatched | null;
}

interface Role {
  id: number;
  name: string;
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={
        online
          ? "inline-block size-2.5 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/20"
          : "inline-block size-2.5 shrink-0 rounded-full bg-zinc-600"
      }
      aria-hidden
    />
  );
}

function Poster({ media }: { media: MediaView }) {
  if (!media.poster) return <div className="h-11 w-8 shrink-0 rounded bg-zinc-800" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={media.poster} alt="" className="h-11 w-8 shrink-0 rounded object-cover" />;
}

function StreamingCell({ s }: { s: NowStreaming }) {
  return (
    <div className="flex items-center gap-2">
      <Poster media={s} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />
          <span className="truncate text-sm text-zinc-100">{s.title}</span>
        </div>
        {s.subtitle && <div className="truncate text-xs text-zinc-500">{s.subtitle}</div>}
        <div className="mt-1 h-1 w-28 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${s.progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  // Poll so online/offline and "now streaming" stay fresh without a manual refresh.
  const { data: users, mutate } = useApi<UserActivity[]>("/users", { refreshInterval: 10_000 });
  const { data: roles } = useApi<Role[]>("/roles");
  const toast = useToast();
  const confirm = useConfirm();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [newRoleId, setNewRoleId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  useEvents();

  async function assignRole(userId: number, roleId: number | null) {
    try {
      await apiFetch(`/users/${userId}`, { method: "PUT", body: JSON.stringify({ roleId }) });
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role");
    }
  }

  async function addUser() {
    if (!username.trim() || password.length < 8) {
      toast.error("Username required and password must be at least 8 characters.");
      return;
    }
    setAdding(true);
    try {
      await apiFetch("/users", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          role,
          roleId: role === "user" ? newRoleId : null,
        }),
      });
      setUsername("");
      setPassword("");
      setRole("user");
      setNewRoleId(null);
      await mutate();
      toast.success("User added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add user");
    } finally {
      setAdding(false);
    }
  }

  async function removeUser(id: number, name: string) {
    if (
      !(await confirm({
        message: `Delete user "${name}"? Their requests and watch history are removed too.`,
        danger: true,
      }))
    )
      return;
    try {
      await apiFetch(`/users/${id}`, { method: "DELETE" });
      await mutate();
      toast.success("User deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const onlineCount = users?.filter((u) => u.online).length ?? 0;
  const streamingCount = users?.filter((u) => u.nowStreaming).length ?? 0;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {users
              ? `${users.length} user${users.length === 1 ? "" : "s"} · ${onlineCount} online · ${streamingCount} streaming`
              : "Loading…"}
          </p>
        </div>
        <Link
          href="/settings/roles"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          Manage roles →
        </Link>
      </div>

      {!users ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : users.length === 0 ? (
        <EmptyState title="No users yet" description="Add your first user with the form below." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH className="w-40">Role</TH>
                <TH className="w-64">Now streaming</TH>
                <TH className="w-56">Last watched</TH>
                <TH className="w-20 text-center">Requests</TH>
                <TH className="w-28">Last seen</TH>
                <TH className="w-20 text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {users.map((u) => (
                <TR key={u.id} className="align-middle">
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <OnlineDot online={u.online} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-100">{u.username}</div>
                        <div className="text-xs text-zinc-500">
                          {u.online ? "Online" : "Offline"}
                        </div>
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <Badge tone={u.role === "admin" ? "accent" : "neutral"}>{u.role}</Badge>
                    {u.role !== "admin" && (roles?.length ?? 0) > 0 && (
                      <Select
                        aria-label={`Role for ${u.username}`}
                        className="mt-1 text-xs"
                        value={u.roleId ?? ""}
                        onChange={(e) =>
                          assignRole(u.id, e.target.value ? Number(e.target.value) : null)
                        }
                      >
                        <option value="">No role</option>
                        {roles?.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </TD>
                  <TD>
                    {u.nowStreaming ? (
                      <StreamingCell s={u.nowStreaming} />
                    ) : (
                      <span className="text-xs text-zinc-600">Not streaming</span>
                    )}
                  </TD>
                  <TD>
                    {u.lastWatched ? (
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm text-zinc-200">
                            {u.lastWatched.title}
                          </span>
                          {u.lastWatched.watched && <Badge tone="success">Finished</Badge>}
                        </div>
                        {u.lastWatched.subtitle && (
                          <div className="truncate text-xs text-zinc-500">
                            {u.lastWatched.subtitle}
                          </div>
                        )}
                        <div className="text-xs text-zinc-600">{timeAgo(u.lastWatched.updatedAt)}</div>
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </TD>
                  <TD className="text-center text-zinc-300">{u.requestCount}</TD>
                  <TD className="whitespace-nowrap text-xs text-zinc-400">
                    {u.online ? <span className="text-emerald-400">now</span> : timeAgo(u.lastSeenAt)}
                  </TD>
                  <TD className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:text-red-300"
                      onClick={() => removeUser(u.id, u.username)}
                    >
                      Delete
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add a user</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="mb-4 text-sm text-zinc-400">
            Regular users browse the library and request movies/series; admins manage everything.
          </p>
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_130px_150px_auto]">
            <Field label="Username" htmlFor="new-username">
              <Input
                id="new-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Password" htmlFor="new-password">
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Role" htmlFor="new-role">
              <Select
                id="new-role"
                value={role}
                onChange={(e) => setRole(e.target.value as "admin" | "user")}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Field label="Permissions" htmlFor="new-role-id">
              <Select
                id="new-role-id"
                value={newRoleId ?? ""}
                disabled={role === "admin"}
                onChange={(e) => setNewRoleId(e.target.value ? Number(e.target.value) : null)}
                title={role === "admin" ? "Admins already have every permission" : undefined}
              >
                <option value="">No role</option>
                {roles?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={addUser} loading={adding} disabled={adding}>
              Add user
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
