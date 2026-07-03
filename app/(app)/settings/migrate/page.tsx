"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import type { QualityProfile, RootFolder } from "@/lib/types";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  HowTo,
  Input,
  Select,
  useToast,
} from "@/components/ui";

type App = "sonarr" | "radarr";

interface Preview {
  app: App;
  version: string;
  itemCount: number;
  /** Items already in the media-box library (by TMDB id); skipped by the migration. */
  existingCount?: number;
  /** itemCount - existingCount: the items that will actually be migrated. */
  newCount?: number;
  items: {
    title: string;
    year: number | null;
    path: string;
    monitored: boolean;
    tmdbId?: number | null;
    /** True when this title is already in the media-box library and will be skipped. */
    exists?: boolean;
  }[];
  profiles: {
    sourceId: number;
    sourceName: string;
    mapped: { name: string; notes: string[] };
  }[];
  rootFolders: string[];
  torznabIndexers: { name: string; url: string }[];
  skippedIndexers: string[];
  qbittorrentClients: { name: string; host: string; port: number }[];
  skippedClients: string[];
}

interface BazarrImport {
  languages: string[];
  provider: string;
  imported: boolean;
  note?: string;
}

/** Subset of app settings: the last-used migration credentials we prefill. */
interface SavedCreds {
  sonarrUrl?: string;
  sonarrApiKey?: string;
  radarrUrl?: string;
  radarrApiKey?: string;
  bazarrUrl?: string;
  bazarrApiKey?: string;
}

export default function MigratePage() {
  const toast = useToast();
  const [app, setApp] = useState<App>("sonarr");
  // Per-app connection creds, so Sonarr and Radarr are each remembered and the
  // right pair appears when you toggle between them.
  const [conns, setConns] = useState<Record<App, { url: string; apiKey: string }>>({
    sonarr: { url: "", apiKey: "" },
    radarr: { url: "", apiKey: "" },
  });
  const url = conns[app].url;
  const apiKey = conns[app].apiKey;
  const setUrl = (v: string) => setConns((c) => ({ ...c, [app]: { ...c[app], url: v } }));
  const setApiKey = (v: string) => setConns((c) => ({ ...c, [app]: { ...c[app], apiKey: v } }));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [executed, setExecuted] = useState(false);

  // decisions
  const [profileMap, setProfileMap] = useState<Record<string, number | "create">>({});
  const [rewriteFrom, setRewriteFrom] = useState("");
  const [rewriteTo, setRewriteTo] = useState("");
  const [importIndexers, setImportIndexers] = useState(true);
  const [importClients, setImportClients] = useState(true);
  const [rootFolderId, setRootFolderId] = useState<number | null>(null);
  // Sonarr/Radarr root folder path -> media-box root folder id (per-root override).
  const [rootFolderMap, setRootFolderMap] = useState<Record<string, number>>({});

  // Bazarr subtitle import (maps to Settings → Subtitles, separate from the arr flow above).
  const [bazarrUrl, setBazarrUrl] = useState("");
  const [bazarrApiKey, setBazarrApiKey] = useState("");
  const [bazarrBusy, setBazarrBusy] = useState(false);
  const [bazarrResult, setBazarrResult] = useState<BazarrImport | null>(null);

  const { data: profiles } = useApi<QualityProfile[]>("/qualityprofiles");
  const { data: rootFolders } = useApi<RootFolder[]>("/rootfolders");
  const { data: savedCreds } = useApi<SavedCreds>("/settings");
  useEvents();

  // Prefill the wizard with the last-used credentials once settings load.
  // Guarded so it seeds exactly once and never clobbers what's being typed.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (savedCreds && !seeded) {
      setConns({
        sonarr: { url: savedCreds.sonarrUrl ?? "", apiKey: savedCreds.sonarrApiKey ?? "" },
        radarr: { url: savedCreds.radarrUrl ?? "", apiKey: savedCreds.radarrApiKey ?? "" },
      });
      setBazarrUrl(savedCreds.bazarrUrl ?? "");
      setBazarrApiKey(savedCreds.bazarrApiKey ?? "");
      setSeeded(true);
    }
  }, [savedCreds, seeded]);

  // Series migration can target both series and anime roots (mapping a Sonarr
  // anime path to the Anime root flags those series as anime); movies target
  // movie roots only.
  const targetFolders = (rootFolders ?? []).filter((f) =>
    app === "sonarr" ? f.mediaType === "series" || f.mediaType === "anime" : f.mediaType === "movies"
  );

  // Media-box root folder ids that are the anime type. A series is flagged as
  // anime when its resolved media-box root is one of these (movies are never
  // anime, so this only matters for the Sonarr/series migration).
  const animeRootIds = useMemo(
    () => new Set((rootFolders ?? []).filter((f) => f.mediaType === "anime").map((f) => f.id)),
    [rootFolders]
  );

  // Source (arr) root paths from the preview, longest first — so the first
  // startsWith match is the longest-prefix match, mirroring the server.
  const sourceRootsByLength = useMemo(
    () => [...(preview?.rootFolders ?? [])].filter(Boolean).sort((a, b) => b.length - a.length),
    [preview]
  );

  // Client-side mirror of the server's resolveItemRoot anime check: find the
  // item's source root by longest-prefix match, map it to a media-box root via
  // the per-root override (falling back to the "attach to" root id), and report
  // whether that root is the anime type. Unmatched/unmapped roots fall to the
  // fallback, so if the fallback is an anime root everything unmapped is anime.
  const resolveAnime = useCallback(
    (itemPath: string): boolean => {
      const srcRoot = sourceRootsByLength.find((p) => itemPath.startsWith(p));
      const mappedRootId = srcRoot ? rootFolderMap[srcRoot] : undefined;
      const resolvedRootId = mappedRootId ?? rootFolderId;
      return resolvedRootId != null && animeRootIds.has(resolvedRootId);
    },
    [sourceRootsByLength, rootFolderMap, rootFolderId, animeRootIds]
  );

  // How many previewed series resolve to an anime root, recomputed whenever the
  // mapping or fallback changes (series migration only — movies aren't anime).
  const animeCount = useMemo(
    () =>
      app === "sonarr" && preview
        ? preview.items.reduce((n, item) => n + (resolveAnime(item.path) ? 1 : 0), 0)
        : 0,
    [app, preview, resolveAnime]
  );

  // How many previewed items are already in the library (skipped) vs. will
  // actually migrate. Fall back gracefully for older preview responses that
  // predate existingCount/newCount.
  const existingCount = preview?.existingCount ?? 0;
  const newCount = preview?.newCount ?? preview?.itemCount ?? 0;

  async function connect() {
    setBusy(true);
    setPreview(null);
    try {
      const res = await apiFetch<Preview>(`/migrate/${app}`, {
        method: "POST",
        body: JSON.stringify({ url, apiKey }),
      });
      setPreview(res);
      // Default each source profile to an existing media-box profile of the same
      // name (case-insensitive) when one exists — so re-running is idempotent and
      // we don't create a second "Any" — else fall back to creating it.
      setProfileMap(
        Object.fromEntries(
          res.profiles.map((p) => {
            const match = (profiles ?? []).find(
              (mp) => mp.name.trim().toLowerCase() === p.mapped.name.trim().toLowerCase()
            );
            return [String(p.sourceId), match ? match.id : "create"];
          })
        )
      );
      // Seed the per-root mapping: point Sonarr roots that look like anime (path
      // contains "anime") at the media-box Anime root when one exists.
      const animeRoot = (rootFolders ?? []).find((f) => f.mediaType === "anime");
      setRootFolderMap(
        animeRoot && app === "sonarr"
          ? Object.fromEntries(
              res.rootFolders
                .filter((rp) => /anime/i.test(rp))
                .map((rp) => [rp, animeRoot.id])
            )
          : {}
      );
      if (res.rootFolders[0]) setRewriteFrom(res.rootFolders[0]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!rootFolderId) return;
    setBusy(true);
    try {
      await apiFetch(`/migrate/${app}`, {
        method: "PUT",
        body: JSON.stringify({
          conn: { url, apiKey },
          decisions: {
            profileMap,
            pathRewrites: rewriteFrom && rewriteTo ? [{ from: rewriteFrom, to: rewriteTo }] : [],
            importIndexers,
            importClients,
            rootFolderId,
            rootFolderMap,
          },
        }),
      });
      setExecuted(true);
      toast.success("Migration started in the background");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Migration failed to start");
    } finally {
      setBusy(false);
    }
  }

  async function importBazarr() {
    setBazarrBusy(true);
    setBazarrResult(null);
    try {
      const res = await apiFetch<BazarrImport>("/migrate/bazarr", {
        method: "POST",
        body: JSON.stringify({ url: bazarrUrl, apiKey: bazarrApiKey }),
      });
      setBazarrResult(res);
      toast.success(`Imported ${res.languages.length} subtitle language(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bazarr import failed");
    } finally {
      setBazarrBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold">Migrate from Sonarr / Radarr</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Imports your library (with monitored flags), quality profiles, Torznab indexers, and
        qBittorrent clients. Files on disk are discovered by a scan afterwards — nothing is moved.
      </p>

      <HowTo title="Migrating from Sonarr / Radarr" className="mt-4">
        <ol>
          <li>
            Pick the app you&apos;re coming from below (<strong>Sonarr</strong> for series,{" "}
            <strong>Radarr</strong> for movies).
          </li>
          <li>
            Point media-box at the running app: enter its <strong>URL</strong> (e.g.{" "}
            <code>http://localhost:8989</code> for Sonarr, <code>http://localhost:7878</code> for
            Radarr) and its <strong>API key</strong> (in the source app under{" "}
            <strong>Settings → General → Security</strong>).
          </li>
          <li>
            Press <strong>Connect</strong> to fetch a preview: the library items, quality profiles,
            Torznab indexers, and qBittorrent clients that will be imported.
          </li>
          <li>
            Review the decisions — map each source quality profile to an existing one or create it,
            choose the <strong>root folder</strong> to attach items to, optionally rewrite path
            prefixes, and toggle indexer/client import.
          </li>
          <li>
            Press <strong>Migrate</strong>. Items import in the background and a disk scan attaches
            existing files afterwards — nothing on disk is moved.
          </li>
        </ol>
      </HowTo>

      <Card className="mt-6">
        <CardBody>
          <div className="flex gap-2">
            {(["sonarr", "radarr"] as const).map((a) => (
              <Button
                key={a}
                size="sm"
                variant={app === a ? "primary" : "secondary"}
                className="capitalize"
                onClick={() => {
                  setApp(a);
                  setPreview(null);
                  setExecuted(false);
                }}
              >
                {a}
              </Button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-3">
            <Field label="URL" htmlFor="migrate-url">
              <Input
                id="migrate-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={app === "sonarr" ? "http://localhost:8989" : "http://localhost:7878"}
              />
            </Field>
            <Field label="API key" htmlFor="migrate-apikey">
              <Input
                id="migrate-apikey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Field>
            <Button
              onClick={connect}
              loading={busy && !preview}
              disabled={busy || !url || !apiKey}
            >
              {busy && !preview ? "Connecting…" : "Connect"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Your last-used credentials are remembered after a successful connect, so you won&apos;t
            have to type them again.
          </p>
        </CardBody>
      </Card>

      {preview && !executed && (
        <>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>
                Found {preview.itemCount} {app === "sonarr" ? "series" : "movies"} ({app} v
                {preview.version})
              </CardTitle>
            </CardHeader>
            <CardBody>
              {existingCount > 0 && (
                <p className="mb-2 text-xs text-zinc-400">
                  <span className="font-semibold text-zinc-300">{newCount}</span> new ·{" "}
                  <span className="font-semibold text-zinc-300">{existingCount}</span> already in
                  library
                </p>
              )}
              <div className="max-h-48 overflow-y-auto rounded border border-zinc-800">
                {preview.items.map((item) => (
                  <div
                    key={item.path}
                    className={`flex items-center justify-between gap-3 border-b border-zinc-800/60 px-3 py-1 text-xs last:border-0${
                      item.exists ? " opacity-60" : ""
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {item.title} {item.year ? `(${item.year})` : ""}
                      {item.exists && <Badge tone="neutral">In library</Badge>}
                      {!item.monitored && <Badge tone="neutral">unmonitored</Badge>}
                      {app === "sonarr" && resolveAnime(item.path) && (
                        <Badge tone="info">Anime</Badge>
                      )}
                    </span>
                    <span className="font-mono text-zinc-500">{item.path}</span>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Quality profiles</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              {preview.profiles.map((p) => (
                <div key={p.sourceId} className="grid grid-cols-[1fr_1fr] items-center gap-3">
                  <div className="text-sm">
                    {p.sourceName}
                    {p.mapped.notes.length > 0 && (
                      <div className="text-xs text-amber-400/80">{p.mapped.notes.join("; ")}</div>
                    )}
                  </div>
                  <Select
                    value={String(profileMap[String(p.sourceId)] ?? "create")}
                    onChange={(e) =>
                      setProfileMap({
                        ...profileMap,
                        [String(p.sourceId)]:
                          e.target.value === "create" ? "create" : Number(e.target.value),
                      })
                    }
                  >
                    <option value="create">Create &quot;{p.mapped.name}&quot;</option>
                    {(profiles ?? []).map((mp) => {
                      const sameName =
                        mp.name.trim().toLowerCase() === p.mapped.name.trim().toLowerCase();
                      return (
                        <option key={mp.id} value={mp.id}>
                          {sameName ? `Use existing "${mp.name}"` : `Map to: ${mp.name}`}
                        </option>
                      );
                    })}
                  </Select>
                </div>
              ))}
            </CardBody>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Paths</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <Field label="Attach migrated items to root folder" htmlFor="migrate-rootfolder">
                <Select
                  id="migrate-rootfolder"
                  value={rootFolderId ?? ""}
                  onChange={(e) => setRootFolderId(Number(e.target.value))}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {targetFolders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.path} ({f.mediaType})
                    </option>
                  ))}
                </Select>
              </Field>

              {preview.rootFolders.length > 0 && (
                <Field
                  label={`Map each ${app} root folder to a media-box root (optional)`}
                  description={
                    app === "sonarr"
                      ? "Send e.g. /tv/Anime to the Anime root and /tv/Series to the Series root. Series under a root mapped to an Anime folder are flagged as anime. Unmapped roots use the folder chosen above."
                      : "Send each source root to a specific media-box root. Unmapped roots use the folder chosen above."
                  }
                >
                  <div className="space-y-2">
                    {preview.rootFolders.map((rp) => (
                      <div key={rp} className="grid grid-cols-[1fr_1fr] items-center gap-3">
                        <span className="truncate font-mono text-xs text-zinc-400" title={rp}>
                          {rp}
                        </span>
                        <Select
                          aria-label={`Media-box root for ${rp}`}
                          value={rootFolderMap[rp] ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setRootFolderMap((prev) => {
                              const next = { ...prev };
                              if (value === "") delete next[rp];
                              else next[rp] = Number(value);
                              return next;
                            });
                          }}
                        >
                          <option value="">Use folder chosen above</option>
                          {targetFolders.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.path} ({f.mediaType})
                            </option>
                          ))}
                        </Select>
                      </div>
                    ))}
                  </div>
                </Field>
              )}

              {app === "sonarr" && (
                <p className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <Badge tone="info">Anime</Badge>
                  <span>
                    <span
                      className={
                        animeCount > 0 ? "font-semibold text-sky-300" : "font-semibold text-zinc-300"
                      }
                    >
                      {animeCount}
                    </span>{" "}
                    of {preview.items.length} series will be flagged as anime with this mapping.
                  </span>
                </p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Field label={`Rewrite path prefix (as ${app} sees it)`} htmlFor="migrate-rewrite-from">
                  <Input
                    id="migrate-rewrite-from"
                    value={rewriteFrom}
                    onChange={(e) => setRewriteFrom(e.target.value)}
                  />
                </Field>
                <Field
                  label="…to (as media-box sees it; empty = keep unchanged)"
                  htmlFor="migrate-rewrite-to"
                >
                  <Input
                    id="migrate-rewrite-to"
                    value={rewriteTo}
                    onChange={(e) => setRewriteTo(e.target.value)}
                  />
                </Field>
              </div>
            </CardBody>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Indexers &amp; clients</CardTitle>
            </CardHeader>
            <CardBody>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <Checkbox
                  checked={importIndexers}
                  onChange={(e) => setImportIndexers(e.target.checked)}
                />
                Import {preview.torznabIndexers.length} Torznab indexer(s)
              </label>
              {preview.skippedIndexers.length > 0 && (
                <p className="ml-6 text-xs text-zinc-500">
                  Skipped (not Torznab): {preview.skippedIndexers.join(", ")}
                </p>
              )}
              <label className="mt-2 flex items-center gap-2 text-sm text-zinc-300">
                <Checkbox
                  checked={importClients}
                  onChange={(e) => setImportClients(e.target.checked)}
                />
                Import {preview.qbittorrentClients.length} qBittorrent client(s)
              </label>
              {preview.skippedClients.length > 0 && (
                <p className="ml-6 text-xs text-zinc-500">
                  Skipped (configure manually): {preview.skippedClients.join(", ")}
                </p>
              )}
            </CardBody>
          </Card>

          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={execute}
                loading={busy}
                disabled={busy || !rootFolderId || newCount === 0}
              >
                {busy ? "Starting…" : `Migrate ${newCount} items`}
              </Button>
              {existingCount > 0 && (
                <span className="text-xs text-zinc-500">
                  {existingCount} already in your library
                </span>
              )}
            </div>
            {newCount === 0 ? (
              <p className="mt-2 text-xs text-zinc-500">
                Everything here is already in your library — nothing to migrate.
              </p>
            ) : !rootFolderId ? (
              <p className="mt-2 text-xs text-zinc-500">
                Choose a root folder to enable migration.
              </p>
            ) : null}
          </div>
        </>
      )}

      {executed && (
        <Callout tone="tip" title="Migration started" className="mt-4">
          <p>
            Migration started in the background. Follow progress under{" "}
            <a href="/system/tasks">System → Tasks</a>; items appear in the library as they are
            imported, and a disk scan will attach existing files afterwards.
          </p>
        </Callout>
      )}

      <div className="mt-10 border-t border-zinc-800 pt-8">
        <h2 className="text-lg font-semibold">Bazarr (subtitles)</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Imports your wanted subtitle languages and OpenSubtitles credentials from an existing
          Bazarr instance into <strong>Settings → Subtitles</strong>. This is separate from the
          library migration above and does not touch your movies or series.
        </p>

        <HowTo title="Importing from Bazarr" className="mt-4">
          <ol>
            <li>
              Point media-box at the running Bazarr: enter its <strong>URL</strong> (e.g.{" "}
              <code>http://localhost:6767</code>) and its <strong>API key</strong> (in Bazarr under{" "}
              <strong>Settings → General → Security</strong>).
            </li>
            <li>
              Press <strong>Import</strong>. media-box reads Bazarr&apos;s enabled languages and, when
              available, its OpenSubtitles.com credentials, and writes them to{" "}
              <strong>Settings → Subtitles</strong>.
            </li>
          </ol>
        </HowTo>

        <Card className="mt-4">
          <CardBody>
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
              <Field label="Bazarr URL" htmlFor="bazarr-url">
                <Input
                  id="bazarr-url"
                  value={bazarrUrl}
                  onChange={(e) => setBazarrUrl(e.target.value)}
                  placeholder="http://localhost:6767"
                />
              </Field>
              <Field label="API key" htmlFor="bazarr-apikey">
                <Input
                  id="bazarr-apikey"
                  type="password"
                  value={bazarrApiKey}
                  onChange={(e) => setBazarrApiKey(e.target.value)}
                />
              </Field>
              <Button
                onClick={importBazarr}
                loading={bazarrBusy}
                disabled={bazarrBusy || !bazarrUrl || !bazarrApiKey}
              >
                {bazarrBusy ? "Importing…" : "Import"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Your last-used Bazarr credentials are remembered after a successful import.
            </p>
          </CardBody>
        </Card>

        {bazarrResult && (
          <Callout tone="tip" title="Subtitle settings imported" className="mt-4">
            <p>
              Imported {bazarrResult.languages.length} language(s)
              {bazarrResult.languages.length > 0 ? `: ${bazarrResult.languages.join(", ")}` : ""}.{" "}
              {bazarrResult.note ??
                "OpenSubtitles credentials were migrated — review them under Settings → Subtitles."}
            </p>
          </Callout>
        )}
      </div>
    </div>
  );
}
