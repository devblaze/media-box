"use client";

import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { formatBytes, tmdbPoster } from "@/lib/types";
import { ReleaseSearchDrawer } from "@/components/release-search";
import { MediaInfoBadges, VideoPlayerModal } from "@/components/media-player";
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

interface QualityDefinition {
  id: number;
  name: string;
}

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

export default function MovieDetailPage({ params }: PageProps<"/movies/[id]">) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, mutate } = useApi<MovieDetail>(`/movies/${id}`);
  const { data: qualityDefs } = useApi<QualityDefinition[]>("/qualitydefinitions");
  const { data: me } = useApi<Me>("/auth/me");
  const isAdmin = me?.role === "admin";
  const [searching, setSearching] = useState(false);
  const [playing, setPlaying] = useState(false);
  const qualityNames = useMemo(
    () => new Map((qualityDefs ?? []).map((q) => [q.id, q.name])),
    [qualityDefs]
  );
  useEvents();

  if (!data) {
    return (
      <div className="flex gap-6">
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

  const poster = tmdbPoster(data.posterPath);

  return (
    <div>
      <div className="flex gap-6">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" className="h-64 rounded object-cover" />
        ) : (
          <div className="h-64 w-44 rounded bg-zinc-800" />
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">
            {data.title} {data.year ? <span className="text-zinc-500">({data.year})</span> : null}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <Badge tone="neutral">{data.status}</Badge>
            <span>·</span>
            <span>{data.runtime ? `${data.runtime} min` : "—"}</span>
            <span>·</span>
            <span className="font-mono text-xs">{data.path}</span>
          </div>
          <p className="mt-3 max-w-3xl text-sm text-zinc-300">{data.overview}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {data.file && (
              <Button variant="primary" size="sm" onClick={() => setPlaying(true)}>
                Play
              </Button>
            )}
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
                <dd className="font-mono text-xs">{data.file.relativePath}</dd>
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

      {searching && (
        <ReleaseSearchDrawer
          scope={{ movieId: data.id }}
          title={`${data.title}${data.year ? ` (${data.year})` : ""}`}
          qualityNames={qualityNames}
          onClose={() => setSearching(false)}
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
