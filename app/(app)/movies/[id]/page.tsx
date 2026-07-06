"use client";

import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { formatBytes, tmdbPoster } from "@/lib/types";
import { ReleaseSearchDrawer } from "@/components/release-search";
import { SubtitleSearchDrawer } from "@/components/subtitle-search";
import { MediaInfoBadges, VideoPlayerModal } from "@/components/media-player";
import { useQueue, DownloadStageBadge } from "@/components/download-stage";
import { movieQueueItem } from "@/lib/download-status";
import type { MediaInfo } from "@/server/library/media-info";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Skeleton,
  useConfirm,
  useToast,
} from "@/components/ui";

interface MovieDetail {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string | null;
  status: string;
  runtime: number | null;
  posterPath: string | null;
  path: string;
  monitored: boolean;
  movieFileId: number | null;
  file: {
    relativePath: string;
    size: number;
    quality: { qualityId: number };
    releaseGroup: string | null;
    mediaInfo: MediaInfo | null;
  } | null;
}

interface CastMember {
  id: number;
  name: string;
  character: string;
  profile: string | null;
}

interface WatchProgress {
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
}

/** "1:23:45" when over an hour, otherwise "MM:SS". */
function formatTime(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

interface QualityDefinition {
  id: number;
  name: string;
}

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

interface MediaVersion {
  fileId: number;
  /** Short resolution tag, e.g. "4K" / "1080p". */
  resolution: string;
  /** Fuller label, e.g. "4K · WEB-DL-2160p". */
  label: string;
  size: number;
  isPrimary: boolean;
}

export default function MovieDetailPage({ params }: PageProps<"/movies/[id]">) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, mutate } = useApi<MovieDetail>(`/movies/${id}`);
  const { data: qualityDefs } = useApi<QualityDefinition[]>("/qualitydefinitions");
  const { data: me } = useApi<Me>("/auth/me");
  const { data: credits } = useApi<{ cast: CastMember[] }>(
    data?.tmdbId ? `/credits?type=movie&tmdbId=${data.tmdbId}` : null
  );
  const { data: progress, mutate: mutateProgress } = useApi<WatchProgress | null>(
    `/watch-progress?movieId=${id}`
  );
  const { data: versionsData, mutate: mutateVersions } = useApi<{ versions: MediaVersion[] }>(
    `/versions?type=movie&id=${id}`
  );
  const isAdmin = me?.role === "admin";
  const [searching, setSearching] = useState(false);
  const [subtitleSearch, setSubtitleSearch] = useState(false);
  const [playing, setPlaying] = useState(false);
  const qualityNames = useMemo(
    () => new Map((qualityDefs ?? []).map((q) => [q.id, q.name])),
    [qualityDefs]
  );
  useEvents();
  const download = movieQueueItem(useQueue(), Number(id));

  if (!data) {
    return (
      <div className="flex flex-col gap-6 md:flex-row">
        <Skeleton className="h-64 w-44" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-20 w-full max-w-3xl" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-32" />
          </div>
        </div>
      </div>
    );
  }

  async function toggleWatched() {
    try {
      await apiFetch("/watch-progress/watched", {
        method: "POST",
        body: JSON.stringify({ movieId: Number(id), watched: !progress?.watched }),
      });
      await mutateProgress();
    } catch {
      toast.error("Failed to update watched state");
    }
  }

  async function toggleMonitored() {
    try {
      await apiFetch(`/movies/${id}`, {
        method: "PUT",
        body: JSON.stringify({ monitored: !data!.monitored }),
      });
      await mutate();
      toast.success(data!.monitored ? "Stopped monitoring" : "Now monitoring");
    } catch {
      toast.error("Failed to update monitoring");
    }
  }

  async function refresh() {
    try {
      await apiFetch("/command", {
        method: "POST",
        body: JSON.stringify({ name: "RefreshMovies", payload: { movieId: data!.id } }),
      });
      toast.success("Metadata refresh queued");
    } catch {
      toast.error("Failed to queue refresh");
    }
  }

  async function rescan() {
    try {
      await apiFetch("/command", {
        method: "POST",
        body: JSON.stringify({ name: "DiskScan", payload: { movieId: data!.id } }),
      });
      toast.success("Disk rescan queued");
    } catch {
      toast.error("Failed to queue rescan");
    }
  }

  async function searchSubtitles() {
    try {
      await apiFetch("/subtitles/search", {
        method: "POST",
        body: JSON.stringify({ movieId: id }),
      });
      toast.success("Subtitle search queued");
    } catch {
      toast.error("Failed to queue subtitle search");
    }
  }

  async function remove() {
    if (
      !(await confirm({
        message: `Remove "${data!.title}" from the library? Files on disk are kept.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    await apiFetch(`/movies/${id}`, { method: "DELETE" });
    router.push("/movies");
  }

  async function deleteVersion(v: MediaVersion) {
    const isLast = (versionsData?.versions.length ?? 0) <= 1;
    if (
      !(await confirm({
        message: isLast
          ? "Delete this version? It is the movie's only file, and it will be removed from disk."
          : "Delete this version? Its file will be removed from disk.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    try {
      await apiFetch(`/movies/${id}/versions/${v.fileId}?deleteFile=true`, { method: "DELETE" });
      await Promise.all([mutateVersions(), mutate()]);
      toast.success(`Deleted ${v.resolution} version`);
    } catch {
      toast.error("Failed to delete version");
    }
  }

  const poster = tmdbPoster(data.posterPath);
  const versions = versionsData?.versions ?? [];

  return (
    <div className="px-4 py-4 md:px-8 md:py-6">
      <div className="flex flex-col gap-6 md:flex-row">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" className="h-64 w-44 shrink-0 self-start rounded object-cover" />
        ) : (
          <div className="h-64 w-44 shrink-0 self-start rounded bg-zinc-800" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">
            {data.title} {data.year ? <span className="text-zinc-500">({data.year})</span> : null}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <Badge tone="neutral">{data.status}</Badge>
            <span>·</span>
            <span>{data.runtime ? `${data.runtime} min` : "—"}</span>
            <span>·</span>
            <span className="font-mono text-xs break-all">{data.path}</span>
            {progress?.watched ? (
              <Badge tone="success">Watched ✓</Badge>
            ) : progress && progress.positionSeconds > 0 ? (
              <Badge tone="info">Resume · {formatTime(progress.positionSeconds)}</Badge>
            ) : null}
            {download && <DownloadStageBadge item={download} />}
          </div>
          <p className="mt-3 max-w-3xl text-sm text-zinc-300">{data.overview}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {data.file && (
              <Button variant="primary" size="sm" onClick={() => setPlaying(true)}>
                Play
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={toggleWatched}>
              {progress?.watched ? "Mark unwatched" : "Mark watched"}
            </Button>
            {isAdmin && (
              <>
                <Button
                  variant={data.monitored ? "primary" : "secondary"}
                  size="sm"
                  onClick={toggleMonitored}
                >
                  {data.monitored ? "Monitored" : "Unmonitored"}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setSearching(true)}>
                  Interactive search
                </Button>
                <Button variant="secondary" size="sm" onClick={refresh}>
                  Refresh metadata
                </Button>
                <Button variant="secondary" size="sm" onClick={rescan}>
                  Rescan disk
                </Button>
                <Button variant="secondary" size="sm" onClick={searchSubtitles}>
                  Search subtitles
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setSubtitleSearch(true)}>
                  Find subtitles…
                </Button>
                <Button variant="danger" size="sm" onClick={remove}>
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>File</CardTitle>
        </CardHeader>
        <CardBody>
          {data.file ? (
            <div className="space-y-4">
              {data.file.mediaInfo && <MediaInfoBadges info={data.file.mediaInfo} />}
              <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                <dt className="text-zinc-500">Path</dt>
                <dd className="font-mono text-xs break-all">{data.file.relativePath}</dd>
                <dt className="text-zinc-500">Size</dt>
                <dd>{formatBytes(data.file.size)}</dd>
                <dt className="text-zinc-500">Quality</dt>
                <dd>
                  {qualityNames.get(data.file.quality.qualityId) ??
                    `#${data.file.quality.qualityId}`}
                </dd>
                <dt className="text-zinc-500">Group</dt>
                <dd>{data.file.releaseGroup ?? "—"}</dd>
              </dl>
            </div>
          ) : (
            <Callout tone="warning">No file — movie is missing.</Callout>
          )}
        </CardBody>
      </Card>

      {versions.length > 0 && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Versions</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {versions.map((v) => {
                // `label` starts with the resolution tag (e.g. "4K · WEB-DL-2160p");
                // strip it so the prominent tag isn't repeated in the descriptor.
                const detail =
                  v.label === v.resolution
                    ? null
                    : v.label.startsWith(`${v.resolution} · `)
                      ? v.label.slice(v.resolution.length + 3)
                      : v.label;
                return (
                  <li
                    key={v.fileId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                  >
                    <span className="text-base font-semibold text-zinc-100">{v.resolution}</span>
                    {detail && <span className="min-w-0 text-sm text-zinc-400">{detail}</span>}
                    {v.isPrimary && <Badge tone="success">Primary</Badge>}
                    <span className="ml-auto text-sm text-zinc-400">{formatBytes(v.size)}</span>
                    {isAdmin && (
                      <Button variant="danger" size="sm" onClick={() => deleteVersion(v)}>
                        Delete
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}

      {credits?.cast && credits.cast.length > 0 && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Cast</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {credits.cast.slice(0, 20).map((c) => (
                <div key={c.id} className="w-24 shrink-0 text-center">
                  {c.profile ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.profile}
                      alt=""
                      loading="lazy"
                      className="mx-auto h-24 w-24 rounded-full object-cover"
                    />
                  ) : (
                    <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-zinc-800 text-lg font-semibold text-zinc-400">
                      {initials(c.name)}
                    </div>
                  )}
                  <div className="mt-2 truncate text-xs font-medium text-zinc-100" title={c.name}>
                    {c.name}
                  </div>
                  {c.character && (
                    <div className="truncate text-xs text-zinc-500" title={c.character}>
                      {c.character}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {searching && (
        <ReleaseSearchDrawer
          scope={{ movieId: data.id }}
          title={`${data.title}${data.year ? ` (${data.year})` : ""}`}
          qualityNames={qualityNames}
          onClose={() => setSearching(false)}
        />
      )}

      {subtitleSearch && (
        <SubtitleSearchDrawer
          target={{ movieId: data.id }}
          title={`${data.title}${data.year ? ` (${data.year})` : ""}`}
          onClose={() => {
            setSubtitleSearch(false);
            void mutate();
          }}
        />
      )}

      {playing && data.file && (
        <VideoPlayerModal
          target={{ type: "movie", id: data.id }}
          title={`${data.title}${data.year ? ` (${data.year})` : ""}`}
          mediaInfo={data.file.mediaInfo}
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}
