"use client";

import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  HowTo,
  Input,
  Modal,
  Switch,
  useConfirm,
  useToast,
} from "@/components/ui";

interface Indexer {
  id: number;
  name: string;
  url: string;
  apiKey: string | null;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  supportsTv: boolean;
  supportsMovies: boolean;
  minimumSeeders: number;
  priority: number;
  enabled: boolean;
}

const EMPTY = {
  name: "",
  url: "",
  apiKey: "",
  minimumSeeders: 1,
  priority: 25,
};

export default function IndexersPage() {
  const { data: indexers, mutate } = useApi<Indexer[]>("/indexers");
  const [editing, setEditing] = useState<Partial<Indexer> | null>(null);

  const list = indexers ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Indexers</h1>
        <Button onClick={() => setEditing(EMPTY)}>Add indexer</Button>
      </div>

      <p className="text-sm text-zinc-400">
        Torznab-compatible indexers (Prowlarr, Jackett, or native tracker torznab endpoints).
      </p>

      <Callout tone="tip">
        Point media-box at a Torznab endpoint from <strong>Prowlarr</strong> or{" "}
        <strong>Jackett</strong> and paste its API key. Use <strong>Test</strong> before saving to
        confirm the connection works.
      </Callout>

      <HowTo title="How do I add an indexer?">
        <ol>
          <li>
            In Prowlarr or Jackett, open the indexer you want and copy its{" "}
            <strong>Torznab feed URL</strong> — it usually looks like{" "}
            <code>http://prowlarr:9696/1/api</code> (Jackett uses{" "}
            <code>http://jackett:9117/api/v2.0/indexers/&lt;id&gt;/results/torznab</code>).
          </li>
          <li>
            Copy the matching <strong>API key</strong> from the same screen and paste it into the{" "}
            <strong>API key</strong> field.
          </li>
          <li>
            media-box searches the standard Torznab <strong>categories</strong> for TV (5000-series)
            and movies (2000-series); the source indexer decides which categories it exposes.
          </li>
          <li>
            Click <strong>Test</strong> to verify connectivity and authentication, then{" "}
            <strong>Save</strong>. Lower <strong>priority</strong> numbers are preferred first.
          </li>
        </ol>
      </HowTo>

      {list.length === 0 ? (
        <EmptyState
          icon="🔎"
          title="No indexers configured"
          description="Add a Torznab-compatible indexer to start searching for releases."
          action={<Button onClick={() => setEditing(EMPTY)}>Add indexer</Button>}
        />
      ) : (
        <div className="space-y-2">
          {list.map((ix) => (
            <button
              key={ix.id}
              onClick={() => setEditing(ix)}
              className="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:border-amber-500/60"
            >
              <div>
                <div className="flex items-center gap-2 font-medium">
                  {ix.name}
                  {!ix.enabled && <Badge tone="neutral">Disabled</Badge>}
                </div>
                <div className="mt-0.5 font-mono text-xs text-zinc-500">{ix.url}</div>
              </div>
              <div className="flex gap-1.5">
                {ix.supportsTv && <Badge tone="info">TV</Badge>}
                {ix.supportsMovies && <Badge tone="accent">Movies</Badge>}
                {ix.enableRss && <Badge tone="neutral">RSS</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}

      {editing && (
        <IndexerDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await mutate();
          }}
          onDeleted={async () => {
            setEditing(null);
            await mutate();
          }}
        />
      )}
    </div>
  );
}

function IndexerDialog({
  initial,
  onClose,
  onSaved,
  onDeleted,
}: {
  initial: Partial<Indexer>;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const isNew = initial.id === undefined;
  const [form, setForm] = useState({
    name: initial.name ?? "",
    url: initial.url ?? "",
    apiKey: initial.apiKey ?? "",
    minimumSeeders: initial.minimumSeeders ?? 1,
    priority: initial.priority ?? 25,
    enableRss: initial.enableRss ?? true,
    enableAutomaticSearch: initial.enableAutomaticSearch ?? true,
    enableInteractiveSearch: initial.enableInteractiveSearch ?? true,
    enabled: initial.enabled ?? true,
  });
  const [pending, setPending] = useState<null | "test" | "save">(null);
  const busy = pending !== null;

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function test() {
    setPending("test");
    try {
      const res = await apiFetch<{ ok: boolean; message?: string }>("/indexers/test", {
        method: "POST",
        body: JSON.stringify({ url: form.url, apiKey: form.apiKey || null }),
      });
      if (res.ok) toast.success(res.message || "Indexer is reachable.");
      else toast.error(res.message || "Test failed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setPending(null);
    }
  }

  async function save() {
    setPending("save");
    try {
      const body = { ...form, apiKey: form.apiKey || null };
      if (isNew) {
        await apiFetch("/indexers", { method: "POST", body: JSON.stringify(body) });
      } else {
        await apiFetch(`/indexers/${initial.id}`, { method: "PUT", body: JSON.stringify(body) });
      }
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      setPending(null);
    }
  }

  async function remove() {
    if (!(await confirm({ message: `Delete indexer "${form.name}"?`, danger: true }))) return;
    try {
      await apiFetch(`/indexers/${initial.id}`, { method: "DELETE" });
      await onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const toggles = [
    ["enabled", "Enabled"],
    ["enableRss", "Use for RSS sync"],
    ["enableAutomaticSearch", "Use for automatic search"],
    ["enableInteractiveSearch", "Use for interactive search"],
  ] as const;

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? "Add indexer" : `Edit ${initial.name}`}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" onClick={remove} className="mr-auto">
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={test}
            disabled={busy || !form.url}
            loading={pending === "test"}
          >
            Test
          </Button>
          <Button
            onClick={save}
            disabled={busy || !form.name || !form.url}
            loading={pending === "save"}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" htmlFor="ix-name" required>
          <Input id="ix-name" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>

        <Field label="Torznab URL" htmlFor="ix-url" required>
          <Input
            id="ix-url"
            value={form.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="http://prowlarr:9696/1/api"
          />
        </Field>

        <Field label="API key" htmlFor="ix-apikey" description="Copied from Prowlarr/Jackett.">
          <Input
            id="ix-apikey"
            value={form.apiKey}
            onChange={(e) => set("apiKey", e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum seeders" htmlFor="ix-seeders">
            <Input
              id="ix-seeders"
              type="number"
              min={0}
              value={form.minimumSeeders}
              onChange={(e) => set("minimumSeeders", Number(e.target.value))}
            />
          </Field>
          <Field label="Priority (1 = highest)" htmlFor="ix-priority">
            <Input
              id="ix-priority"
              type="number"
              min={1}
              max={50}
              value={form.priority}
              onChange={(e) => set("priority", Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="space-y-2.5 pt-1">
          {toggles.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <label htmlFor={`ix-${key}`} className="text-sm text-zinc-300">
                {label}
              </label>
              <Switch
                id={`ix-${key}`}
                checked={form[key]}
                onChange={(v) => set(key, v)}
                aria-label={label}
              />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
