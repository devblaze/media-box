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

type IndexerType = "torznab" | "builtin";

interface Indexer {
  id: number;
  name: string;
  type: IndexerType;
  definition: string | null;
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

interface Builtin {
  key: string;
  name: string;
  description: string;
  site: string;
  supportsTv: boolean;
  supportsMovies: boolean;
  categories: number[];
}

const EMPTY: Partial<Indexer> = {
  type: "torznab",
  name: "",
  url: "",
  apiKey: "",
  minimumSeeders: 1,
  priority: 25,
};

export default function IndexersPage() {
  const { data: indexers, mutate } = useApi<Indexer[]>("/indexers");
  const { data: builtins } = useApi<Builtin[]>("/indexers/builtins");
  const [editing, setEditing] = useState<Partial<Indexer> | null>(null);
  const [picking, setPicking] = useState(false);

  const list = indexers ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Indexers</h1>
        <div className="flex gap-2">
          <Button onClick={() => setPicking(true)}>Add built-in</Button>
          <Button variant="secondary" onClick={() => setEditing({ ...EMPTY })}>
            Add Torznab
          </Button>
        </div>
      </div>

      <p className="text-sm text-zinc-400">
        <strong>Built-in</strong> indexers scrape popular public trackers directly — no Prowlarr or
        Jackett required. <strong>Torznab</strong> indexers point at an external Prowlarr/Jackett
        feed for private trackers and the long tail.
      </p>

      <Callout tone="tip">
        Start with a <strong>built-in</strong> source (e.g. The Pirate Bay or YTS) for zero-setup
        public torrents, and add <strong>Torznab</strong> feeds from Prowlarr/Jackett for anything
        they don&apos;t cover. Lower <strong>priority</strong> numbers are preferred first.
      </Callout>

      <HowTo title="How do I add an indexer?">
        <ol>
          <li>
            <strong>Built-in:</strong> click <strong>Add built-in</strong> and pick a source. It
            works immediately — no URL or API key. Use <strong>Test</strong> to confirm it&apos;s
            reachable.
          </li>
          <li>
            <strong>Torznab:</strong> in Prowlarr/Jackett, copy the indexer&apos;s{" "}
            <strong>Torznab feed URL</strong> (e.g. <code>http://prowlarr:9696/1/api</code>) and its{" "}
            <strong>API key</strong>, then paste both here.
          </li>
          <li>
            media-box searches the standard Torznab <strong>categories</strong> for TV (5000-series)
            and movies (2000-series).
          </li>
          <li>
            Click <strong>Test</strong> to verify, then <strong>Save</strong>.
          </li>
        </ol>
      </HowTo>

      {list.length === 0 ? (
        <EmptyState
          icon="🔎"
          title="No indexers configured"
          description="Add a built-in source or a Torznab feed to start searching for releases."
          action={<Button onClick={() => setPicking(true)}>Add built-in</Button>}
        />
      ) : (
        <div className="space-y-2">
          {list.map((ix) => (
            <button
              key={ix.id}
              onClick={() => setEditing(ix)}
              className="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:border-amber-500/60"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  {ix.name}
                  {!ix.enabled && <Badge tone="neutral">Disabled</Badge>}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                  {ix.type === "builtin"
                    ? `Built-in · ${builtins?.find((b) => b.key === ix.definition)?.site ?? ix.definition}`
                    : ix.url}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {ix.type === "builtin" && <Badge tone="success">Built-in</Badge>}
                {ix.supportsTv && <Badge tone="info">TV</Badge>}
                {ix.supportsMovies && <Badge tone="accent">Movies</Badge>}
                {ix.enableRss && <Badge tone="neutral">RSS</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}

      {picking && (
        <BuiltinPicker
          builtins={builtins ?? []}
          existing={list}
          onClose={() => setPicking(false)}
          onAdded={async () => {
            setPicking(false);
            await mutate();
          }}
        />
      )}

      {editing && (
        <IndexerDialog
          initial={editing}
          builtins={builtins ?? []}
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

function BuiltinPicker({
  builtins,
  existing,
  onClose,
  onAdded,
}: {
  builtins: Builtin[];
  existing: Indexer[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState<string | null>(null);
  const addedKeys = new Set(
    existing.filter((i) => i.type === "builtin").map((i) => i.definition)
  );

  async function add(b: Builtin) {
    setAdding(b.key);
    try {
      await apiFetch("/indexers", {
        method: "POST",
        body: JSON.stringify({ type: "builtin", definition: b.key, name: b.name }),
      });
      toast.success(`Added ${b.name}`);
      await onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add");
      setAdding(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a built-in indexer"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="mb-3 text-sm text-zinc-400">
        These scrape public trackers directly. No account, URL or API key needed.
      </p>
      {builtins.length === 0 ? (
        <p className="text-sm text-zinc-500">No built-in sources available.</p>
      ) : (
        <div className="space-y-2">
          {builtins.map((b) => {
            const added = addedKeys.has(b.key);
            return (
              <div
                key={b.key}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    {b.name}
                    {b.supportsTv && <Badge tone="info">TV</Badge>}
                    {b.supportsMovies && <Badge tone="accent">Movies</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">{b.description}</div>
                </div>
                <Button
                  size="sm"
                  variant={added ? "ghost" : "primary"}
                  disabled={added || adding !== null}
                  loading={adding === b.key}
                  onClick={() => add(b)}
                >
                  {added ? "Added" : "Add"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function IndexerDialog({
  initial,
  builtins,
  onClose,
  onSaved,
  onDeleted,
}: {
  initial: Partial<Indexer>;
  builtins: Builtin[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const isNew = initial.id === undefined;
  const isBuiltin = initial.type === "builtin";
  const source = isBuiltin ? builtins.find((b) => b.key === initial.definition) : undefined;
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
      const body = isBuiltin
        ? { type: "builtin", definition: initial.definition }
        : { type: "torznab", url: form.url, apiKey: form.apiKey || null };
      const res = await apiFetch<{ ok: boolean; message?: string }>("/indexers/test", {
        method: "POST",
        body: JSON.stringify(body),
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
      const body = isBuiltin
        ? {
            name: form.name,
            type: "builtin",
            definition: initial.definition,
            minimumSeeders: form.minimumSeeders,
            priority: form.priority,
            enableRss: form.enableRss,
            enableAutomaticSearch: form.enableAutomaticSearch,
            enableInteractiveSearch: form.enableInteractiveSearch,
            enabled: form.enabled,
          }
        : { ...form, type: "torznab", apiKey: form.apiKey || null };
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

  const canSave = isBuiltin ? Boolean(form.name) : Boolean(form.name && form.url);

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? (isBuiltin ? `Add ${source?.name ?? "indexer"}` : "Add Torznab indexer") : `Edit ${initial.name}`}
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
            disabled={busy || (!isBuiltin && !form.url)}
            loading={pending === "test"}
          >
            Test
          </Button>
          <Button onClick={save} disabled={busy || !canSave} loading={pending === "save"}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {isBuiltin && source && (
          <Callout tone="info">
            Built-in source: <strong>{source.name}</strong> —{" "}
            <a href={source.site} target="_blank" rel="noreferrer" className="underline">
              {source.site}
            </a>
            . {source.description}
          </Callout>
        )}

        <Field label="Name" htmlFor="ix-name" required>
          <Input id="ix-name" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>

        {!isBuiltin && (
          <>
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
          </>
        )}

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
