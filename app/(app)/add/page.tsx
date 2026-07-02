"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, useApi } from "@/lib/api";
import type { LookupResult, QualityProfile, RootFolder } from "@/lib/types";
import {
  Button,
  Input,
  Select,
  Checkbox,
  Field,
  Modal,
  Callout,
  EmptyState,
  useToast,
} from "@/components/ui";

type MediaType = "series" | "movie";

export default function AddPage() {
  const router = useRouter();
  const toast = useToast();
  const [mediaType, setMediaType] = useState<MediaType>("series");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<LookupResult | null>(null);

  const { data: rootFolders } = useApi<RootFolder[]>("/rootfolders");
  const { data: profiles } = useApi<QualityProfile[]>("/qualityprofiles");

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await apiFetch<LookupResult[]>(
        `/lookup?type=${mediaType}&q=${encodeURIComponent(query)}`
      );
      setResults(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">Add New</h1>

      <div className="mt-4 flex gap-2">
        <div className="flex gap-1">
          {(["series", "movie"] as const).map((t) => (
            <Button
              key={t}
              variant={mediaType === t ? "primary" : "secondary"}
              onClick={() => {
                setMediaType(t);
                setResults(null);
              }}
            >
              {t === "series" ? "Series" : "Movies"}
            </Button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder={`Search TMDB for a ${mediaType === "series" ? "series" : "movie"}…`}
          className="flex-1"
        />
        <Button onClick={search} loading={searching}>
          Search
        </Button>
      </div>

      {results &&
        (results.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              title="No results"
              description={`Nothing matched “${query}”. Try a different search term.`}
            />
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {results.map((r) => (
              <button
                key={r.tmdbId}
                onClick={() => setSelected(r)}
                className="group rounded border border-zinc-800 bg-zinc-900/50 p-3 text-left hover:border-amber-500/60"
              >
                {r.poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.poster} alt="" className="aspect-[2/3] w-full rounded object-cover" />
                ) : (
                  <div className="aspect-[2/3] w-full rounded bg-zinc-800" />
                )}
                <div className="mt-2 text-sm font-medium group-hover:text-amber-300">
                  {r.title} {r.year ? <span className="text-zinc-500">({r.year})</span> : null}
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-zinc-400">{r.overview}</p>
              </button>
            ))}
          </div>
        ))}

      {selected && rootFolders && profiles && (
        <AddDialog
          item={selected}
          mediaType={mediaType}
          rootFolders={rootFolders.filter(
            (f) => f.mediaType === (mediaType === "series" ? "series" : "movies")
          )}
          profiles={profiles}
          onClose={() => setSelected(null)}
          onAdded={(id) => router.push(mediaType === "series" ? `/series/${id}` : `/movies/${id}`)}
        />
      )}
    </div>
  );
}

function AddDialog({
  item,
  mediaType,
  rootFolders,
  profiles,
  onClose,
  onAdded,
}: {
  item: LookupResult;
  mediaType: MediaType;
  rootFolders: RootFolder[];
  profiles: QualityProfile[];
  onClose: () => void;
  onAdded: (id: number) => void;
}) {
  const toast = useToast();
  const [rootFolderId, setRootFolderId] = useState(rootFolders[0]?.id ?? 0);
  const [qualityProfileId, setQualityProfileId] = useState(profiles[0]?.id ?? 0);
  const [monitored, setMonitored] = useState(true);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      const row = await apiFetch<{ id: number }>(mediaType === "series" ? "/series" : "/movies", {
        method: "POST",
        body: JSON.stringify({ tmdbId: item.tmdbId, rootFolderId, qualityProfileId, monitored }),
      });
      onAdded(row.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Add failed");
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!busy}
      title={`Add ${item.title} ${item.year ? `(${item.year})` : ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} loading={busy} disabled={rootFolders.length === 0}>
            Add
          </Button>
        </>
      }
    >
      {rootFolders.length === 0 ? (
        <Callout tone="warning">
          No {mediaType === "series" ? "series" : "movie"} root folder configured. Add one under
          Settings → Media Management first.
        </Callout>
      ) : (
        <div className="space-y-4">
          <Field label="Root folder" htmlFor="add-root-folder">
            <Select
              id="add-root-folder"
              value={rootFolderId}
              onChange={(e) => setRootFolderId(Number(e.target.value))}
            >
              {rootFolders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quality profile" htmlFor="add-quality-profile">
            <Select
              id="add-quality-profile"
              value={qualityProfileId}
              onChange={(e) => setQualityProfileId(Number(e.target.value))}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <Checkbox checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
            Monitored (search for missing automatically)
          </label>
        </div>
      )}
    </Modal>
  );
}
