"use client";

import { useEffect, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { formatBytes, type RootFolder } from "@/lib/types";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  HowTo,
  Input,
  Modal,
  Select,
  Skeleton,
  Spinner,
  Switch,
  TBody,
  TD,
  TR,
  Table,
  useConfirm,
  useToast,
} from "@/components/ui";

interface FsListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
}

export default function MediaManagementPage() {
  const { data: folders, mutate } = useApi<RootFolder[]>("/rootfolders");
  const [adding, setAdding] = useState<"series" | "movies" | "anime" | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  async function removeFolder(id: number) {
    if (
      !(await confirm({
        title: "Remove root folder",
        message: "Remove this root folder? Files already on disk are not deleted.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await apiFetch(`/rootfolders/${id}`, { method: "DELETE" });
      await mutate();
      toast.success("Root folder removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Media Management</h1>

      <FileOperationsSection />

      {(["series", "movies", "anime"] as const).map((type) => {
        const rows = (folders ?? []).filter((f) => f.mediaType === type);
        const label = type === "series" ? "Series" : type === "movies" ? "Movie" : "Anime";
        return (
          <Card key={type}>
            <CardHeader>
              <CardTitle>{label} root folders</CardTitle>
              <Button size="sm" onClick={() => setAdding(type)}>
                Add folder
              </Button>
            </CardHeader>
            <CardBody>
              {!folders ? (
                <div className="space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-2/3" />
                </div>
              ) : rows.length === 0 ? (
                <EmptyState
                  title="No root folders configured"
                  description={`Add a folder where imported ${type} should be stored.`}
                  action={
                    <Button size="sm" onClick={() => setAdding(type)}>
                      Add folder
                    </Button>
                  }
                />
              ) : (
                <Table>
                  <TBody>
                    {rows.map((f) => (
                      <TR key={f.id}>
                        <TD className="font-mono text-xs">{f.path}</TD>
                        <TD className="w-32 text-xs">
                          {f.accessible ? (
                            <span className="text-zinc-500">{formatBytes(f.freeSpace)} free</span>
                          ) : (
                            <Badge tone="danger">inaccessible</Badge>
                          )}
                        </TD>
                        <TD className="w-16 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-400 hover:text-red-300"
                            onClick={() => removeFolder(f.id)}
                          >
                            Remove
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        );
      })}

      <Callout tone="info" title="What are root folders?">
        Root folders are where imported media lives (e.g. <code>/data/media/tv</code> and{" "}
        <code>/data/media/movies</code>). Configure the download and library paths below so imports
        can hardlink instead of copy.
      </Callout>

      <PathsSection />
      <NamingSection />
      <RemotePathMappingsSection />

      {adding && (
        <DirectoryPicker
          onClose={() => setAdding(null)}
          onPick={async (path) => {
            await apiFetch("/rootfolders", {
              method: "POST",
              body: JSON.stringify({ path, mediaType: adding }),
            });
            setAdding(null);
            await mutate();
          }}
        />
      )}
    </div>
  );
}

/**
 * Master read-only switch. When OFF, media-box never moves, renames, or deletes
 * files anywhere — imports/organizing pause and delete-from-disk is refused —
 * enforced server-side by the media-guard. Turning it OFF asks for confirmation;
 * turning it back ON resumes automation.
 */
function FileOperationsSection() {
  const { data, mutate } = useApi<{ fileOperationsEnabled: boolean }>("/settings");
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const enabled = data?.fileOperationsEnabled ?? true;

  async function toggle(next: boolean) {
    if (!next) {
      const confirmed = await confirm({
        title: "Turn on read-only mode?",
        message:
          "media-box will stop moving, renaming, and deleting files. Imports and organizing pause — downloads keep running and import automatically once you turn this back on — and deleting a movie or series will only remove it from the library, never from disk.",
        confirmLabel: "Turn on read-only",
        danger: true,
      });
      if (!confirmed) return;
    }
    setSaving(true);
    // Optimistic: reflect the flip immediately, roll back on failure.
    void mutate((s) => (s ? { ...s, fileOperationsEnabled: next } : s), false);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({ fileOperationsEnabled: next }),
      });
      await mutate();
      toast.success(
        next
          ? "File operations enabled — imports, moves, and deletes are active."
          : "Read-only mode on — media files will not be moved, renamed, or deleted."
      );
    } catch (err) {
      await mutate();
      toast.error(err instanceof Error ? err.message : "Failed to update setting");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-100">Allow file operations</span>
            <Badge tone={enabled ? "success" : "danger"}>{enabled ? "On" : "Read-only"}</Badge>
          </div>
          <p className="mt-1 max-w-xl text-sm text-zinc-400">
            {enabled
              ? "media-box may move, rename, and delete files: imports and organizing run normally, and deleting a title can remove its files from disk."
              : "Read-only mode. media-box will never move, rename, or delete files. Imports and organizing are paused (downloads keep running and import automatically once you re-enable this), and deleting a title only removes it from the library — never from disk."}
          </p>
        </div>
        <Switch
          checked={enabled}
          onChange={toggle}
          disabled={!data || saving}
          aria-label="Allow file operations"
        />
      </CardBody>
    </Card>
  );
}

interface LibraryPaths {
  downloadsPath: string;
  moviesPath: string;
  seriesPath: string;
  animePath: string;
  importMode: "auto" | "hardlink" | "copy" | "move";
  maxBacklogGrabsPerRun: number;
}

type PathKey = "downloadsPath" | "moviesPath" | "seriesPath" | "animePath";

function PathsSection() {
  const { data, mutate } = useApi<LibraryPaths>("/settings");
  const [form, setForm] = useState<LibraryPaths | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState<PathKey | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (data && !form) {
      setForm({
        downloadsPath: data.downloadsPath ?? "",
        moviesPath: data.moviesPath ?? "",
        seriesPath: data.seriesPath ?? "",
        animePath: data.animePath ?? "",
        importMode: data.importMode ?? "auto",
        maxBacklogGrabsPerRun: data.maxBacklogGrabsPerRun ?? 0,
      });
    }
  }, [data, form]);

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({
          downloadsPath: form.downloadsPath,
          moviesPath: form.moviesPath,
          seriesPath: form.seriesPath,
          animePath: form.animePath,
          importMode: form.importMode,
          maxBacklogGrabsPerRun: form.maxBacklogGrabsPerRun,
        }),
      });
      await mutate();
      toast.success("Paths saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const pathFields: { key: PathKey; label: string; description: string; placeholder: string }[] = [
    {
      key: "downloadsPath",
      label: "Downloads",
      description: "Where your download client saves completed files.",
      placeholder: "/data/downloads",
    },
    {
      key: "moviesPath",
      label: "Movies library",
      description: "Where finished movies are imported.",
      placeholder: "/data/media/movies",
    },
    {
      key: "seriesPath",
      label: "Series library",
      description: "Where finished series/episodes are imported.",
      placeholder: "/data/media/tv",
    },
    {
      key: "animePath",
      label: "Anime library",
      description: "Where finished anime series are imported.",
      placeholder: "/data/media/anime",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Library paths</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <Callout tone="warning" title="Keep downloads and libraries on one filesystem">
          When your downloads folder and your movie/series libraries live on{" "}
          <strong>different filesystems</strong> (for example separate Unraid shares), media-box has
          to <strong>copy</strong> every import instead of hardlinking it — that is slower and needs
          as much free space as the file itself. Put downloads and libraries on the{" "}
          <strong>same filesystem</strong> for instant, space-free hardlinks.
        </Callout>

        {!form ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <>
            {pathFields.map(({ key, label, description, placeholder }) => (
              <Field key={key} label={label} description={description} htmlFor={key}>
                <div className="flex gap-2">
                  <Input
                    id={key}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    placeholder={placeholder}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setPicking(key)}
                    className="shrink-0"
                  >
                    Browse
                  </Button>
                </div>
              </Field>
            ))}

            <Field
              label="Import mode"
              htmlFor="importMode"
              description="How imported files land in the library. Auto hardlinks when possible and copies across filesystems."
            >
              <Select
                id="importMode"
                value={form.importMode}
                onChange={(e) =>
                  setForm({ ...form, importMode: e.target.value as LibraryPaths["importMode"] })
                }
              >
                <option value="auto">auto</option>
                <option value="hardlink">hardlink</option>
                <option value="copy">copy</option>
                <option value="move">move</option>
              </Select>
            </Field>

            <Field
              label="Backlog grabs per run"
              htmlFor="maxBacklogGrabsPerRun"
              description="How many missing releases the daily backlog search grabs each run. Keeps automatic back-filling slow. 0 = unlimited."
            >
              <Input
                id="maxBacklogGrabsPerRun"
                type="number"
                min={0}
                max={50}
                value={form.maxBacklogGrabsPerRun}
                onChange={(e) =>
                  setForm({ ...form, maxBacklogGrabsPerRun: Number(e.target.value) })
                }
              />
            </Field>

            <div>
              <Button onClick={save} loading={saving} disabled={saving}>
                Save paths
              </Button>
            </div>
          </>
        )}

        <HowTo title="Setting up your paths">
          <ol>
            <li>
              Create one parent share/folder that holds everything, for example <code>/data</code>.
            </li>
            <li>
              Point your download client at a subfolder like <code>/data/downloads</code> and set{" "}
              <strong>Downloads</strong> above to match.
            </li>
            <li>
              Set <strong>Movies library</strong> to <code>/data/media/movies</code> and{" "}
              <strong>Series library</strong> to <code>/data/media/tv</code> — all under the same{" "}
              <code>/data</code>.
            </li>
            <li>
              Because everything sits on one filesystem, imports <strong>hardlink</strong> instantly
              and use no extra space, and your torrents keep seeding.
            </li>
            <li>
              Use the <strong>Browse</strong> button beside each field to pick folders without
              typing.
            </li>
            <li>
              If a download client runs in another container and reports a path media-box cannot see,
              add a <strong>remote path mapping</strong> below.
            </li>
          </ol>
        </HowTo>
      </CardBody>

      {picking && (
        <DirectoryPicker
          onClose={() => setPicking(null)}
          onPick={async (path) => {
            setForm((f) => (f ? { ...f, [picking]: path } : f));
            setPicking(null);
          }}
        />
      )}
    </Card>
  );
}

interface NamingConfig {
  renameEpisodes: boolean;
  standardEpisodeFormat: string;
  seriesFolderFormat: string;
  seasonFolderFormat: string;
  movieFormat: string;
  movieFolderFormat: string;
}

function NamingSection() {
  const { data, mutate } = useApi<NamingConfig>("/naming");
  const [form, setForm] = useState<NamingConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);

  const fields: { key: keyof NamingConfig & string; label: string; example: string }[] = [
    {
      key: "standardEpisodeFormat",
      label: "Episode format",
      example: "{Series Title} - S{season:00}E{episode:00} - {Episode Title}",
    },
    { key: "seriesFolderFormat", label: "Series folder", example: "{Series Title} ({Year})" },
    { key: "seasonFolderFormat", label: "Season folder", example: "Season {season:00}" },
    { key: "movieFormat", label: "Movie format", example: "{Movie Title} ({Year}) {Quality}" },
    { key: "movieFolderFormat", label: "Movie folder", example: "{Movie Title} ({Year})" },
  ];

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await apiFetch("/naming", { method: "PUT", body: JSON.stringify(form) });
      await mutate();
      toast.success("Naming saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Naming</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <Callout tone="tip" title="Available tokens">
          <p>
            <code>{"{Series Title}"}</code> <code>{"{Movie Title}"}</code>{" "}
            <code>{"{Episode Title}"}</code> <code>{"{Year}"}</code> <code>{"{season:00}"}</code>{" "}
            <code>{"{episode:00}"}</code> <code>{"{Quality}"}</code> <code>{"{Release Group}"}</code>
          </p>
        </Callout>

        {!form ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <>
            {fields.map(({ key, label, example }) => (
              <Field key={key} label={label} description={`e.g. ${example}`} htmlFor={key}>
                <Input
                  id={key}
                  value={String(form[key])}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  className="font-mono text-xs"
                />
              </Field>
            ))}
            <div>
              <Button onClick={save} loading={saving} disabled={saving}>
                Save naming
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

interface RemoteMapping {
  id: number;
  downloadClientId: number;
  remotePath: string;
  localPath: string;
}

interface ClientOption {
  id: number;
  name: string;
}

function RemotePathMappingsSection() {
  const { data: mappings, mutate } = useApi<RemoteMapping[]>("/remotepathmappings");
  const { data: clients } = useApi<ClientOption[]>("/downloadclients");
  const [remotePath, setRemotePath] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [clientId, setClientId] = useState<number | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const clientName = (id: number) => clients?.find((c) => c.id === id)?.name ?? `#${id}`;

  async function add() {
    try {
      await apiFetch("/remotepathmappings", {
        method: "POST",
        body: JSON.stringify({
          downloadClientId: clientId ?? clients?.[0]?.id,
          remotePath,
          localPath,
        }),
      });
      setRemotePath("");
      setLocalPath("");
      await mutate();
      toast.success("Mapping added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add mapping");
    }
  }

  async function remove(id: number) {
    if (
      !(await confirm({
        title: "Remove mapping",
        message: "Remove this remote path mapping?",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await apiFetch(`/remotepathmappings?id=${id}`, { method: "DELETE" });
      await mutate();
      toast.success("Mapping removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Remote path mappings</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-zinc-500">
          Needed only when a download client reports paths media-box cannot see (e.g. qBittorrent in
          another container using <code>/downloads</code> while media-box sees{" "}
          <code>/data/torrents</code>).
        </p>

        {(mappings ?? []).length > 0 && (
          <Table>
            <TBody>
              {(mappings ?? []).map((m) => (
                <TR key={m.id}>
                  <TD className="text-xs text-zinc-400">{clientName(m.downloadClientId)}</TD>
                  <TD className="font-mono text-xs">{m.remotePath}</TD>
                  <TD className="w-6 text-center text-zinc-500">→</TD>
                  <TD className="font-mono text-xs">{m.localPath}</TD>
                  <TD className="w-16 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:text-red-300"
                      onClick={() => remove(m.id)}
                    >
                      Remove
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {(clients ?? []).length > 0 ? (
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <Field label="Client" htmlFor="rpm-client">
              <Select
                id="rpm-client"
                value={clientId ?? clients![0]?.id}
                onChange={(e) => setClientId(Number(e.target.value))}
              >
                {clients!.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Remote path" htmlFor="rpm-remote">
              <Input
                id="rpm-remote"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder="/downloads/"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Local path" htmlFor="rpm-local">
              <Input
                id="rpm-local"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/data/torrents/"
                className="font-mono text-xs"
              />
            </Field>
            <Button onClick={add} disabled={!remotePath || !localPath}>
              Add
            </Button>
          </div>
        ) : (
          <Callout tone="info">Add a download client first.</Callout>
        )}
      </CardBody>
    </Card>
  );
}

function DirectoryPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState("/");
  const { data } = useApi<FsListing>(`/fs?path=${encodeURIComponent(current)}`);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title="Choose a folder"
      dismissable={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              setBusy(true);
              try {
                await onPick(data?.path ?? current);
              } finally {
                setBusy(false);
              }
            }}
            loading={busy}
            disabled={busy || !data}
          >
            Use this folder
          </Button>
        </>
      }
    >
      <div className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs">
        {data?.path ?? current}
      </div>
      <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-md border border-zinc-800">
        {data?.parent !== null && data?.parent !== undefined && (
          <button
            onClick={() => setCurrent(data.parent!)}
            className="block w-full px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-800"
          >
            ..
          </button>
        )}
        {(data?.directories ?? []).map((d) => (
          <button
            key={d.path}
            onClick={() => setCurrent(d.path)}
            className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-zinc-800"
          >
            {d.name}
          </button>
        ))}
        {!data && (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-500">
            <Spinner className="size-4" /> Loading…
          </div>
        )}
      </div>
    </Modal>
  );
}
