"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { tmdbPoster, type Episode, type Season } from "@/lib/types";
import { ReleaseSearchDrawer, type SearchScope } from "@/components/release-search";
import { MediaInfoBadges, VideoPlayerModal } from "@/components/media-player";
import type { MediaInfo } from "@/server/library/media-info";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Select,
  Skeleton,
  TBody,
  TD,
  TR,
  useConfirm,
  useToast,
} from "@/components/ui";

interface CastMember {
  id: number;
  name: string;
  character: string;
  profile: string | null;
}

interface EpProgress {
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

interface EpisodeFileLite {
  id: number;
  relativePath: string;
  size: number;
  quality: { qualityId: number };
  mediaInfo: MediaInfo | null;
}

interface SeriesDetail {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string | null;
  status: string;
  network: string | null;
  posterPath: string | null;
  path: string;
  monitored: boolean;
  monitorMode: "all" | "future" | "none";
  isAnime: boolean;
  seasons: Season[];
  episodes: Episode[];
  files: EpisodeFileLite[];
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

export default function SeriesDetailPage({ params }: PageProps<"/series/[id]">) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, mutate } = useApi<SeriesDetail>(`/series/${id}`);
  const { data: qualityDefs } = useApi<QualityDefinition[]>("/qualitydefinitions");
  const { data: me } = useApi<Me>("/auth/me");
  const { data: credits } = useApi<{ cast: CastMember[] }>(
    data?.tmdbId ? `/credits?type=series&tmdbId=${data.tmdbId}` : null
  );
  const isAdmin = me?.role === "admin";
  const [progressMap, setProgressMap] = useState<Map<number, EpProgress>>(new Map());
  const [searchScope, setSearchScope] = useState<{ scope: SearchScope; label: string } | null>(null);
  const [playing, setPlaying] = useState<{ episodeId: number; label: string } | null>(null);
  const qualityNames = useMemo(
    () => new Map((qualityDefs ?? []).map((q) => [q.id, q.name])),
    [qualityDefs]
  );
  useEvents();

  const episodesBySeason = useMemo(() => {
    const map = new Map<number, Episode[]>();
    for (const ep of data?.episodes ?? []) {
      const list = map.get(ep.seasonNumber) ?? [];
      list.push(ep);
      map.set(ep.seasonNumber, list);
    }
    return map;
  }, [data]);

  const filesById = useMemo(
    () => new Map((data?.files ?? []).map((f) => [f.id, f])),
    [data]
  );

  // Only downloaded episodes can carry watch state; fetch each in the background
  // so the page renders immediately regardless of how many requests are in flight.
  const fileEpisodeIds = useMemo(
    () => (data?.episodes ?? []).filter((e) => e.episodeFileId).map((e) => e.id),
    [data]
  );

  const loadProgress = useCallback(async () => {
    if (fileEpisodeIds.length === 0) {
      setProgressMap(new Map());
      return;
    }
    const entries = await Promise.all(
      fileEpisodeIds.map(async (epId) => {
        try {
          const p = await apiFetch<EpProgress | null>(`/watch-progress?episodeId=${epId}`);
          return [epId, p] as const;
        } catch {
          return [epId, null] as const;
        }
      })
    );
    const next = new Map<number, EpProgress>();
    for (const [epId, p] of entries) if (p) next.set(epId, p);
    setProgressMap(next);
  }, [fileEpisodeIds]);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  const allWatched =
    fileEpisodeIds.length > 0 && fileEpisodeIds.every((epId) => progressMap.get(epId)?.watched);

  if (!data) {
    return (
      <div className="flex gap-6">
        <Skeleton className="h-64 w-44" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-20 w-full max-w-3xl" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
      </div>
    );
  }

  async function toggleSeriesWatched() {
    try {
      await apiFetch("/watch-progress/watched", {
        method: "POST",
        body: JSON.stringify({ seriesId: data!.id, watched: !allWatched }),
      });
      await loadProgress();
      toast.success(allWatched ? "Marked series unwatched" : "Marked series watched");
    } catch {
      toast.error("Failed to update watched state");
    }
  }

  async function toggleEpisodeWatched(episodeId: number, watched: boolean) {
    try {
      await apiFetch("/watch-progress/watched", {
        method: "POST",
        body: JSON.stringify({ episodeId, watched }),
      });
      await loadProgress();
    } catch {
      toast.error("Failed to update watched state");
    }
  }

  async function toggleSeriesMonitored() {
    await apiFetch(`/series/${id}`, {
      method: "PUT",
      body: JSON.stringify({ monitored: !data!.monitored }),
    });
    await mutate();
  }

  async function changeMonitorMode(value: "all" | "future" | "none") {
    try {
      await apiFetch(`/series/${id}`, {
        method: "PUT",
        body: JSON.stringify({ monitorMode: value }),
      });
      await mutate();
      toast.success("Monitoring updated");
    } catch {
      toast.error("Failed to update monitoring");
    }
  }

  async function toggleSeasonMonitored(season: Season) {
    await apiFetch(`/series/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        seasons: [{ seasonNumber: season.seasonNumber, monitored: !season.monitored }],
      }),
    });
    await mutate();
  }

  async function refresh() {
    try {
      await apiFetch("/command", {
        method: "POST",
        body: JSON.stringify({ name: "RefreshSeries", payload: { seriesId: data!.id } }),
      });
      toast.info("Metadata refresh queued");
    } catch {
      toast.error("Failed to queue metadata refresh");
    }
  }

  async function rescan() {
    try {
      await apiFetch("/command", {
        method: "POST",
        body: JSON.stringify({ name: "DiskScan", payload: { seriesId: data!.id } }),
      });
      toast.info("Disk rescan queued");
    } catch {
      toast.error("Failed to queue disk rescan");
    }
  }

  async function searchSubtitles() {
    try {
      await apiFetch("/subtitles/search", {
        method: "POST",
        body: JSON.stringify({ seriesId: id }),
      });
      toast.success("Subtitle search queued");
    } catch {
      toast.error("Failed to queue subtitle search");
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: "Remove series",
        message: `Remove "${data!.title}" from the library? Files on disk are kept.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await apiFetch(`/series/${id}`, { method: "DELETE" });
      router.push("/series");
    } catch {
      toast.error("Failed to remove series");
    }
  }

  const poster = tmdbPoster(data.posterPath);

  const visibleSeasons = data.seasons
    .filter((s) => s.seasonNumber > 0 || (episodesBySeason.get(0)?.length ?? 0) > 0)
    .sort((a, b) => b.seasonNumber - a.seasonNumber);

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
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
            <span>
              {data.title}{" "}
              {data.year ? <span className="text-zinc-500">({data.year})</span> : null}
            </span>
            {data.isAnime && <Badge tone="accent">Anime</Badge>}
          </h1>
          <div className="mt-1 text-sm text-zinc-400">
            {data.network ?? "—"} · {data.status} · <span className="font-mono text-xs">{data.path}</span>
          </div>
          <p className="mt-3 max-w-3xl text-sm text-zinc-300">{data.overview}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={toggleSeriesWatched}>
              {allWatched ? "Mark series unwatched" : "Mark series watched"}
            </Button>
            {isAdmin && (
              <>
                <Button
                  variant={data.monitored ? "primary" : "secondary"}
                  size="sm"
                  onClick={toggleSeriesMonitored}
                >
                  {data.monitored ? "Monitored" : "Unmonitored"}
                </Button>
              <label className="flex items-center gap-2 text-sm text-zinc-400">
                <span>Monitoring</span>
                <div className="w-44">
                  <Select
                    aria-label="Monitoring"
                    value={data.monitorMode}
                    onChange={(e) =>
                      changeMonitorMode(e.target.value as "all" | "future" | "none")
                    }
                  >
                    <option value="all">All episodes</option>
                    <option value="future">Future episodes</option>
                    <option value="none">None</option>
                  </Select>
                </div>
              </label>
              <Button variant="secondary" size="sm" onClick={refresh}>
                Refresh metadata
              </Button>
              <Button variant="secondary" size="sm" onClick={rescan}>
                Rescan disk
              </Button>
              <Button variant="secondary" size="sm" onClick={searchSubtitles}>
                Search subtitles
              </Button>
                <Button variant="danger" size="sm" onClick={remove}>
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-8 space-y-6">
        {visibleSeasons.length === 0 ? (
          <EmptyState
            title="No seasons yet"
            description="This series has no episodes in the library. Refresh metadata to pull the latest season list."
          />
        ) : (
          visibleSeasons.map((season) => {
            const eps = episodesBySeason.get(season.seasonNumber) ?? [];
            const withFile = eps.filter((e) => e.episodeFileId).length;
            return (
              <Card key={season.id}>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleSeasonMonitored(season)}
                        title={season.monitored ? "Monitored — click to unmonitor" : "Unmonitored — click to monitor"}
                      >
                        <span
                          className={`text-lg leading-none ${
                            season.monitored ? "text-amber-400" : "text-zinc-600"
                          }`}
                        >
                          ●
                        </span>
                      </Button>
                    )}
                    <CardTitle>
                      {season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`}
                    </CardTitle>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone="neutral">
                      {withFile}/{eps.length} episodes
                    </Badge>
                    {isAdmin && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setSearchScope({
                            scope: { seriesId: data.id, season: season.seasonNumber },
                            label: `${data.title} — Season ${season.seasonNumber}`,
                          })
                        }
                      >
                        Search season
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <table className="w-full text-sm">
                  <TBody>
                    {eps.map((ep) => {
                      const file = ep.episodeFileId ? filesById.get(ep.episodeFileId) : undefined;
                      const epLabel = `${data.title} S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`;
                      const prog = progressMap.get(ep.id);
                      const watched = prog?.watched ?? false;
                      const inProgress =
                        !watched &&
                        !!prog &&
                        prog.positionSeconds > 0 &&
                        prog.durationSeconds > 0;
                      return (
                        <TR key={ep.id}>
                          <TD className="w-12">
                            <span className="text-zinc-500">{ep.episodeNumber}</span>
                          </TD>
                          <TD>
                            <div className={watched ? "text-zinc-400" : undefined}>
                              {ep.title ?? "TBA"}
                            </div>
                            {file?.mediaInfo && (
                              <MediaInfoBadges info={file.mediaInfo} className="mt-1 flex flex-wrap items-center gap-1" />
                            )}
                            {inProgress && (
                              <div className="mt-1 h-1 w-full max-w-xs overflow-hidden rounded-full bg-zinc-800">
                                <div
                                  className="h-full bg-amber-500"
                                  style={{
                                    width: `${Math.min(100, Math.round((prog.positionSeconds / prog.durationSeconds) * 100))}%`,
                                  }}
                                />
                              </div>
                            )}
                          </TD>
                          <TD className="w-28">
                            <span className="text-xs text-zinc-500">
                              {ep.airDateUtc ? new Date(ep.airDateUtc).toLocaleDateString() : "—"}
                            </span>
                          </TD>
                          <TD className="w-24 text-right">
                            {ep.episodeFileId ? (
                              <Badge tone="success">Downloaded</Badge>
                            ) : ep.airDateUtc && new Date(ep.airDateUtc) < new Date() ? (
                              <Badge tone="warning">Missing</Badge>
                            ) : (
                              <Badge tone="neutral">Unaired</Badge>
                            )}
                          </TD>
                          <TD className="w-40 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {ep.episodeFileId && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={
                                    watched
                                      ? "Watched — click to mark unwatched"
                                      : "Mark watched"
                                  }
                                  onClick={() => toggleEpisodeWatched(ep.id, !watched)}
                                >
                                  <span
                                    className={`text-base leading-none ${
                                      watched ? "text-emerald-400" : "text-zinc-600"
                                    }`}
                                  >
                                    ✓
                                  </span>
                                </Button>
                              )}
                              {ep.episodeFileId && (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => setPlaying({ episodeId: ep.id, label: epLabel })}
                                >
                                  Play
                                </Button>
                              )}
                              {isAdmin && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() =>
                                    setSearchScope({
                                      scope: { episodeId: ep.id },
                                      label: epLabel,
                                    })
                                  }
                                >
                                  Search
                                </Button>
                              )}
                            </div>
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </table>
              </Card>
            );
          })
        )}
      </div>

      {credits?.cast && credits.cast.length > 0 && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>{data.isAnime ? "Voice cast" : "Cast"}</CardTitle>
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

      {searchScope && (
        <ReleaseSearchDrawer
          scope={searchScope.scope}
          title={searchScope.label}
          qualityNames={qualityNames}
          onClose={() => setSearchScope(null)}
        />
      )}

      {playing && (
        <VideoPlayerModal
          target={{ type: "episode", id: playing.episodeId }}
          title={playing.label}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}
