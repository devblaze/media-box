"use client";

import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Field,
  HowTo,
  Input,
  Modal,
  Skeleton,
  useConfirm,
  useToast,
} from "@/components/ui";

type ClientType = "qbittorrent" | "torbox";

interface DownloadClientRow {
  id: number;
  name: string;
  type: ClientType;
  settings: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  removeCompletedDownloads: boolean;
}

export default function DownloadClientsPage() {
  const { data: clients, mutate, isLoading } = useApi<DownloadClientRow[]>("/downloadclients");
  const [editing, setEditing] = useState<Partial<DownloadClientRow> | null>(null);
  const [addType, setAddType] = useState<ClientType | null>(null);

  const rows = clients ?? [];

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Download Clients</h1>
        <div className="flex gap-2">
          <Button onClick={() => setAddType("qbittorrent")}>Add qBittorrent</Button>
          <Button onClick={() => setAddType("torbox")}>Add TorBox</Button>
        </div>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No download clients configured"
            description="Add qBittorrent or TorBox so media-box can send and fetch downloads."
            action={
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setAddType("qbittorrent")}>
                  Add qBittorrent
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setAddType("torbox")}>
                  Add TorBox
                </Button>
              </div>
            }
          />
        ) : (
          <div className="space-y-2">
            {rows.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setEditing(c)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:border-amber-500/60"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium text-zinc-100">
                    <span className="truncate">{c.name}</span>
                    {!c.enabled && <Badge tone="neutral">disabled</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {c.type === "qbittorrent"
                      ? `qBittorrent — ${String(c.settings.host ?? "")}:${String(c.settings.port ?? "")}`
                      : "TorBox (debrid)"}
                  </div>
                </div>
                <Badge tone="neutral">priority {c.priority}</Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      {(editing || addType) && (
        <ClientDialog
          initial={editing ?? { type: addType! }}
          onClose={() => {
            setEditing(null);
            setAddType(null);
          }}
          onChanged={async () => {
            setEditing(null);
            setAddType(null);
            await mutate();
          }}
        />
      )}
    </div>
  );
}

function ClientDialog({
  initial,
  onClose,
  onChanged,
}: {
  initial: Partial<DownloadClientRow>;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const toast = useToast();

  const type = initial.type!;
  const isNew = initial.id === undefined;
  const s = (initial.settings ?? {}) as Record<string, unknown>;

  const [name, setName] = useState(initial.name ?? (type === "qbittorrent" ? "qBittorrent" : "TorBox"));
  const [enabled, setEnabled] = useState(initial.enabled ?? true);
  const [priority, setPriority] = useState(initial.priority ?? 1);
  const [removeCompleted, setRemoveCompleted] = useState(initial.removeCompletedDownloads ?? true);
  // qbittorrent
  const [host, setHost] = useState(String(s.host ?? "localhost"));
  const [port, setPort] = useState(Number(s.port ?? 8080));
  const [useSsl, setUseSsl] = useState(Boolean(s.useSsl ?? false));
  const [username, setUsername] = useState(String(s.username ?? ""));
  const [password, setPassword] = useState(String(s.password ?? ""));
  const [category, setCategory] = useState(String(s.category ?? "media-box"));
  // torbox
  const [apiKey, setApiKey] = useState(String(s.apiKey ?? ""));
  const [stagingDir, setStagingDir] = useState(String(s.stagingDir ?? "/data/torbox"));

  // Tracks which async action is in flight so buttons show their own spinner.
  const [pending, setPending] = useState<null | "test" | "save">(null);
  const busy = pending !== null;

  function body() {
    const settings =
      type === "qbittorrent"
        ? { host, port, useSsl, username, password, category }
        : { apiKey, stagingDir };
    return {
      type,
      name,
      settings,
      enabled,
      priority,
      removeCompletedDownloads: removeCompleted,
    };
  }

  async function test() {
    setPending("test");
    try {
      // Include the id when editing a saved client so the server can restore any
      // secret left as the "••••••••" placeholder (otherwise Test would send the
      // masked bullets as the real credential).
      const res = await apiFetch<{ ok: boolean; message?: string }>("/downloadclients/test", {
        method: "POST",
        body: JSON.stringify(initial.id !== undefined ? { ...body(), id: initial.id } : body()),
      });
      if (res.ok) {
        toast.success(res.message ?? "Connection successful");
      } else {
        toast.error(res.message ?? "Test failed");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setPending(null);
    }
  }

  async function save() {
    setPending("save");
    try {
      if (isNew) {
        await apiFetch("/downloadclients", { method: "POST", body: JSON.stringify(body()) });
      } else {
        await apiFetch(`/downloadclients/${initial.id}`, { method: "PUT", body: JSON.stringify(body()) });
      }
      toast.success(isNew ? `Added "${name}"` : `Saved "${name}"`);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      setPending(null);
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: "Delete download client",
        message: `Delete download client "${name}"?`,
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    try {
      await apiFetch(`/downloadclients/${initial.id}`, { method: "DELETE" });
      toast.success(`Deleted "${name}"`);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!busy}
      size="lg"
      title={
        isNew ? `Add ${type === "qbittorrent" ? "qBittorrent" : "TorBox"}` : `Edit ${initial.name}`
      }
      footer={
        <>
          {!isNew && (
            <Button variant="danger" className="mr-auto" onClick={remove} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={test} loading={pending === "test"} disabled={busy}>
            Test
          </Button>
          <Button onClick={save} loading={pending === "save"} disabled={busy || !name}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Callout tone="tip" title="qBittorrent vs TorBox">
          <strong>qBittorrent</strong> is a self-hosted torrent client you run yourself — it needs a
          host, port and WebUI login. <strong>TorBox</strong> is a cloud debrid service that
          downloads on your behalf — it only needs an <strong>API key</strong>.
        </Callout>

        <Field label="Name" htmlFor="dc-name">
          <Input id="dc-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {type === "qbittorrent" ? (
          <>
            <div className="grid grid-cols-[1fr_110px] gap-3">
              <Field label="Host" htmlFor="dc-host">
                <Input id="dc-host" value={host} onChange={(e) => setHost(e.target.value)} />
              </Field>
              <Field label="Port" htmlFor="dc-port">
                <Input
                  id="dc-port"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username" htmlFor="dc-username">
                <Input
                  id="dc-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <Field label="Password" htmlFor="dc-password">
                <Input
                  id="dc-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category" htmlFor="dc-category">
                <Input
                  id="dc-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-zinc-300">
                <Checkbox checked={useSsl} onChange={(e) => setUseSsl(e.target.checked)} />
                Use SSL
              </label>
            </div>

            <HowTo title="How do I connect qBittorrent?">
              <ol>
                <li>
                  In qBittorrent, open <strong>Tools → Options → Web UI</strong> and enable{" "}
                  <strong>Web User Interface (Remote control)</strong>. media-box talks to this
                  WebUI — if it is not enabled, the connection will fail.
                </li>
                <li>
                  Set <strong>Host</strong> to where qBittorrent runs (e.g. <code>localhost</code>,
                  or its container name / IP) and <strong>Port</strong> to the WebUI port (default{" "}
                  <code>8080</code>).
                </li>
                <li>
                  Enter the WebUI <strong>Username</strong> and <strong>Password</strong> from that
                  same panel. Turn on <strong>Use SSL</strong> only if the WebUI is served over
                  HTTPS.
                </li>
                <li>
                  Pick a <strong>Category</strong> (e.g. <code>media-box</code>). Downloads are
                  tagged with it so media-box can find and import them.
                </li>
                <li>
                  Click <strong>Test</strong> to verify the connection, then <strong>Save</strong>.
                </li>
              </ol>
            </HowTo>
          </>
        ) : (
          <>
            <Field label="API key" htmlFor="dc-apikey">
              <Input
                id="dc-apikey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Field>
            <Field
              label="Local staging directory"
              htmlFor="dc-staging"
              description="Completed TorBox downloads are fetched here before import."
            >
              <Input
                id="dc-staging"
                value={stagingDir}
                onChange={(e) => setStagingDir(e.target.value)}
              />
            </Field>

            <HowTo title="How do I connect TorBox?">
              <ol>
                <li>
                  Sign in at{" "}
                  <a href="https://torbox.app" target="_blank" rel="noreferrer">
                    torbox.app
                  </a>{" "}
                  and open your account <strong>Settings</strong>.
                </li>
                <li>
                  Find the <strong>API key</strong> section and copy your key (create one if you
                  don&apos;t have it yet).
                </li>
                <li>
                  Paste it into <strong>API key</strong> above. That is the only credential TorBox
                  needs — there is no host or port to configure.
                </li>
                <li>
                  Leave the <strong>staging directory</strong> at its default unless you know you
                  need a different path.
                </li>
                <li>
                  Click <strong>Test</strong> to verify the connection, then <strong>Save</strong>.
                </li>
              </ol>
            </HowTo>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority (1 = first choice)" htmlFor="dc-priority">
            <Input
              id="dc-priority"
              type="number"
              min={1}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </Field>
          <div className="space-y-1.5 self-end pb-2 text-sm text-zinc-300">
            <label className="flex items-center gap-2">
              <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={removeCompleted}
                onChange={(e) => setRemoveCompleted(e.target.checked)}
              />
              Remove after import
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}
