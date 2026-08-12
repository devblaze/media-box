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
  Switch,
  useConfirm,
  useToast,
} from "@/components/ui";

type IndexerType = "torznab" | "builtin" | "cardigann";

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  language: string;
  links: string[];
  supported: boolean;
  unsupportedReason?: string;
  categories: number[];
  supportsTv: boolean;
  supportsMovies: boolean;
}

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
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<Indexer> | null>(null);
  const [picking, setPicking] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<
    Record<number, { ok: boolean; message: string; latencyMs: number }>
  >({});

  const list = indexers ?? [];
  const hasTorznab = list.some((i) => i.type === "torznab");

  async function testAll() {
    setTesting(true);
    try {
      const { results } = await apiFetch<{
        results: { id: number; ok: boolean; message: string; latencyMs: number }[];
      }>("/indexers/test-all", { method: "POST" });
      const map: Record<number, { ok: boolean; message: string; latencyMs: number }> = {};
      for (const r of results) map[r.id] = { ok: r.ok, message: r.message, latencyMs: r.latencyMs };
      setTestResults(map);
      const up = results.filter((r) => r.ok).length;
      const msg = `${up} of ${results.length} indexers reachable`;
      if (up === results.length) toast.success(msg);
      else toast.info(msg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Indexers</h1>
        <div className="flex flex-wrap justify-end gap-2">
          {list.length > 0 && (
            <Button variant="outline" onClick={testAll} loading={testing}>
              Test all
            </Button>
          )}
          {hasTorznab && (
            <Button variant="outline" onClick={() => setMigrating(true)}>
              Migrate from Jackett
            </Button>
          )}
          <Button onClick={() => setBrowsing(true)}>Browse indexers</Button>
          <Button variant="secondary" onClick={() => setPicking(true)}>
            Add built-in
          </Button>
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
                  {testResults[ix.id] &&
                    (testResults[ix.id].ok ? (
                      <Badge tone="success">✓ {testResults[ix.id].latencyMs} ms</Badge>
                    ) : (
                      <Badge tone="danger">✗ unreachable</Badge>
                    ))}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                  {ix.type === "builtin"
                    ? `Built-in · ${builtins?.find((b) => b.key === ix.definition)?.site ?? ix.definition}`
                    : ix.type === "cardigann"
                      ? `Native · ${ix.definition}${ix.url ? ` · ${ix.url}` : ""}`
                      : ix.url}
                </div>
                {testResults[ix.id] && !testResults[ix.id].ok && (
                  <div className="mt-0.5 truncate text-xs text-red-400">
                    {testResults[ix.id].message}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                {ix.type === "builtin" && <Badge tone="success">Built-in</Badge>}
                {ix.type === "cardigann" && <Badge tone="success">Native</Badge>}
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

      {browsing && (
        <CatalogPicker
          existing={list}
          onClose={() => setBrowsing(false)}
          onAdded={async () => {
            await mutate();
          }}
        />
      )}

      {migrating && (
        <MigratePanel
          onClose={() => setMigrating(false)}
          onMigrated={async () => {
            setMigrating(false);
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

/**
 * The full public-tracker catalog: Jackett/Prowlarr YAML definitions that
 * media-box runs natively (no Jackett needed). Definitions that use features
 * the engine doesn't implement yet are listed too, greyed out with the reason,
 * so it's clear what's available vs. what still needs a Torznab feed.
 */
function CatalogPicker({
  existing,
  onClose,
  onAdded,
}: {
  existing: Indexer[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const toast = useToast();
  const { data: entries, error } = useApi<{ entries: CatalogEntry[] }>("/indexers/catalog");
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(
    new Set(existing.filter((i) => i.type === "cardigann").map((i) => i.definition ?? ""))
  );

  const all = entries?.entries ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? all.filter(
        (e) => e.name.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle)
      )
    : all;
  const supportedCount = all.filter((e) => e.supported).length;

  async function add(entry: CatalogEntry) {
    setAdding(entry.id);
    try {
      await apiFetch("/indexers", {
        method: "POST",
        body: JSON.stringify({ type: "cardigann", definition: entry.id, name: entry.name }),
      });
      toast.success(`Added ${entry.name}`);
      setAdded((prev) => new Set(prev).add(entry.id));
      await onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Browse indexers"
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="mb-3 text-sm text-zinc-400">
        Public trackers media-box can search <strong>directly</strong>, using the same indexer
        definitions Jackett/Prowlarr use — no Jackett required. Definitions are fetched from the
        Prowlarr catalog and cached.
      </p>

      {error && (
        <Callout tone="danger">
          Could not load the catalog — the server may not have reached the definition repository.
        </Callout>
      )}

      {!entries && !error && (
        <p className="text-sm text-zinc-500">Loading the catalog… (the first load fetches it)</p>
      )}

      {entries && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search trackers…"
            />
            <span className="shrink-0 text-xs text-zinc-500">
              {supportedCount} available
            </span>
          </div>

          <div className="space-y-2">
            {visible.map((entry) => {
              const isAdded = added.has(entry.id);
              return (
                <div
                  key={entry.id}
                  className={`flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3 ${
                    entry.supported ? "" : "opacity-60"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {entry.name}
                      {entry.supportsTv && <Badge tone="info">TV</Badge>}
                      {entry.supportsMovies && <Badge tone="accent">Movies</Badge>}
                      {!entry.supported && <Badge tone="warning">Needs Jackett</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {entry.supported
                        ? entry.description || entry.links[0]
                        : `Not supported natively yet — ${entry.unsupportedReason}. Add it as a Torznab feed instead.`}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={isAdded ? "ghost" : "primary"}
                    disabled={isAdded || !entry.supported || adding !== null}
                    loading={adding === entry.id}
                    onClick={() => add(entry)}
                  >
                    {isAdded ? "Added" : "Add"}
                  </Button>
                </div>
              );
            })}
            {visible.length === 0 && (
              <p className="text-sm text-zinc-500">No trackers match that search.</p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

interface MigratePreview {
  migratable: { id: number; name: string; url: string; builtinKey: string; builtinName: string }[];
  unmatched: { id: number; name: string; url: string }[];
}

/**
 * Replace Jackett/Torznab indexers with their native built-in equivalents.
 * Preview (what matches) → pick → apply; unmatched feeds are listed so it's
 * clear they stay on Jackett until a native scraper exists for them.
 */
function MigratePanel({
  onClose,
  onMigrated,
}: {
  onClose: () => void;
  onMigrated: () => Promise<void>;
}) {
  const toast = useToast();
  const { data: preview } = useApi<MigratePreview>("/indexers/migrate");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [applying, setApplying] = useState(false);

  // Pre-select every migratable feed once the preview arrives.
  if (preview && !seeded) {
    setSelected(new Set(preview.migratable.map((m) => m.id)));
    setSeeded(true);
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    setApplying(true);
    try {
      const { migrated } = await apiFetch<{ migrated: number }>("/indexers/migrate", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected] }),
      });
      toast.success(
        `Migrated ${migrated} indexer${migrated === 1 ? "" : "s"} to built-in — no Jackett needed for ${migrated === 1 ? "it" : "them"}.`
      );
      await onMigrated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Migration failed");
      setApplying(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Migrate from Jackett"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={apply}
            disabled={applying || selected.size === 0}
            loading={applying}
          >
            Migrate {selected.size > 0 ? `${selected.size} indexer${selected.size === 1 ? "" : "s"}` : ""}
          </Button>
        </>
      }
    >
      {!preview ? (
        <p className="text-sm text-zinc-500">Checking your Torznab indexers…</p>
      ) : (
        <div className="space-y-4">
          {preview.migratable.length === 0 ? (
            <Callout tone="info">
              None of your Torznab indexers match a built-in source yet. As more built-ins are
              added, they&apos;ll show up here.
            </Callout>
          ) : (
            <div>
              <p className="mb-2 text-sm text-zinc-400">
                These Jackett/Torznab feeds have a native equivalent. Migrating switches them to the
                built-in scraper — same searches, <strong>no Jackett dependency</strong>. Settings
                (priority, seeders, toggles) are kept.
              </p>
              <div className="space-y-2">
                {preview.migratable.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3"
                  >
                    <Checkbox
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                      aria-label={`Migrate ${m.name}`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium">
                        {m.name} <span className="text-zinc-500">→</span>{" "}
                        <span className="text-amber-400">{m.builtinName}</span>{" "}
                        <Badge tone="success">Built-in</Badge>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">{m.url}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {preview.unmatched.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-zinc-400">
                No native equivalent yet — these keep working through Jackett/Prowlarr:
              </p>
              <ul className="space-y-1">
                {preview.unmatched.map((u) => (
                  <li key={u.id} className="truncate text-xs text-zinc-500">
                    • {u.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
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
  const isCardigann = initial.type === "cardigann";
  // Built-ins and native (Cardigann) indexers both need no URL/API key — they
  // share the "no Torznab fields, no URL required" shape of this dialog.
  const isBuiltin = initial.type === "builtin" || isCardigann;
  const source =
    initial.type === "builtin" ? builtins.find((b) => b.key === initial.definition) : undefined;
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
      const body = isCardigann
        ? { type: "cardigann", definition: initial.definition, url: form.url || null }
        : isBuiltin
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
            type: isCardigann ? "cardigann" : "builtin",
            definition: initial.definition,
            // Cardigann keeps `url` as an optional base-URL override (mirrors).
            ...(isCardigann ? { url: form.url } : {}),
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

        {isCardigann && (
          <>
            <Callout tone="info">
              Native indexer — media-box searches <strong>{initial.definition}</strong> directly
              using its Jackett/Prowlarr definition. No account or API key needed.
            </Callout>
            <Field
              label="Site URL (optional)"
              htmlFor="ix-baseurl"
              description="Only needed if the tracker moved domain — leave blank to use the definition's default."
            >
              <Input
                id="ix-baseurl"
                value={form.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://example-mirror.to/"
              />
            </Field>
          </>
        )}

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
