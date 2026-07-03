"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, Skeleton } from "@/components/ui";
import { formatBytes, type MovieSummary, type RootFolder, type SeriesSummary } from "@/lib/types";

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

interface SystemStatus {
  appName: string;
  version: string;
  startedAt: string;
  configDir: string;
  node: string;
}

interface QueueItem {
  id: number;
  status: string;
}

interface WantedData {
  episodes: { episodeId: number }[];
  movies: { movieId: number }[];
}

interface HistoryRow {
  id: number;
  eventType: string;
  mediaType: "series" | "movie";
  sourceTitle: string | null;
  date: number | string;
  seriesTitle: string | null;
  movieTitle: string | null;
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-zinc-100",
  accent: "text-amber-400",
  success: "text-emerald-400",
  warning: "text-yellow-400",
  danger: "text-red-400",
  info: "text-sky-400",
};

const EVENT_META: Record<string, { label: string; tone: Tone }> = {
  grabbed: { label: "Grabbed", tone: "accent" },
  imported: { label: "Imported", tone: "success" },
  downloadFailed: { label: "Failed", tone: "danger" },
  fileDeleted: { label: "Deleted", tone: "neutral" },
  fileRenamed: { label: "Renamed", tone: "neutral" },
  ignored: { label: "Ignored", tone: "neutral" },
};

/** Returns the length when data has loaded, 0 on error, undefined while loading. */
function toCount(len: number | undefined, error: unknown): number | undefined {
  if (len !== undefined) return len;
  return error ? 0 : undefined;
}

function StatCard({
  label,
  value,
  hint,
  href,
  tone = "neutral",
}: {
  label: string;
  value: number | undefined;
  hint?: React.ReactNode;
  href?: string;
  tone?: Tone;
}) {
  const numberTone = value ? TONE_TEXT[tone] : "text-zinc-100";
  const card = (
    <Card className={href ? "h-full transition-colors hover:border-zinc-700" : "h-full"}>
      <CardBody>
        <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
        {value === undefined ? (
          <Skeleton className="mt-2 h-8 w-16" />
        ) : (
          <div className={`mt-1 text-3xl font-semibold ${numberTone}`}>{value}</div>
        )}
        {hint !== undefined &&
          (value === undefined ? (
            <Skeleton className="mt-2 h-3 w-24" />
          ) : (
            <div className="mt-1 text-xs text-zinc-500">{hint}</div>
          ))}
      </CardBody>
    </Card>
  );
  return href ? (
    <Link href={href} className="block">
      {card}
    </Link>
  ) : (
    card
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { data: me } = useApi<Me>("/auth/me");
  const { data: system } = useApi<SystemStatus>("/system/status");
  const { data: series, error: seriesError } = useApi<SeriesSummary[]>("/series");
  const { data: movies, error: moviesError } = useApi<MovieSummary[]>("/movies");
  const { data: queue, error: queueError } = useApi<QueueItem[]>("/queue");
  const { data: wanted, error: wantedError } = useApi<WantedData>("/wanted");
  const { data: history, error: historyError } = useApi<HistoryRow[]>("/history");
  const { data: rootFolders, error: rootFoldersError } = useApi<RootFolder[]>("/rootfolders");

  // Keep counts and activity live as the server emits events.
  useEvents();

  // Non-admins get the browse-and-play experience: bounce them to Discover.
  useEffect(() => {
    if (me && me.role !== "admin") router.replace("/discover");
  }, [me, router]);

  // Wait until the role is known before committing to a view.
  if (!me) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }
  // Non-admins are redirecting to /discover; render nothing in the meantime.
  if (me.role !== "admin") return null;

  const seriesCount = toCount(series?.length, seriesError);
  const moviesCount = toCount(movies?.length, moviesError);
  const queueCount = toCount(queue?.length, queueError);
  const missingCount = toCount(
    wanted ? wanted.episodes.length + wanted.movies.length : undefined,
    wantedError
  );

  const seriesMonitored = series?.filter((s) => s.monitored).length;
  const moviesDownloaded = movies?.filter((m) => m.movieFileId != null).length;
  const queueDownloading = queue?.filter((q) => q.status === "downloading").length;

  const recent = history?.slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Overview of your library, downloads, and storage.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Series"
          value={seriesCount}
          href="/series"
          hint={seriesMonitored !== undefined ? `${seriesMonitored} monitored` : undefined}
        />
        <StatCard
          label="Movies"
          value={moviesCount}
          href="/movies"
          hint={moviesDownloaded !== undefined ? `${moviesDownloaded} downloaded` : undefined}
        />
        <StatCard
          label="Missing"
          value={missingCount}
          href="/wanted"
          tone="danger"
          hint={
            wanted
              ? `${wanted.episodes.length} episodes · ${wanted.movies.length} movies`
              : undefined
          }
        />
        <StatCard
          label="Queue"
          value={queueCount}
          href="/activity/queue"
          tone="accent"
          hint={queueDownloading !== undefined ? `${queueDownloading} downloading` : undefined}
        />
      </div>

      {/* [&>*]:min-w-0 lets grid-item cards shrink below their content so long
          paths/filenames truncate instead of forcing the card past the viewport. */}
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        {/* Recent activity */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <Link href="/activity/history" className="text-xs text-amber-400 hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardBody>
            {historyError ? (
              <EmptyState title="Activity unavailable" description="Could not load recent history." />
            ) : recent === undefined ? (
              <ul className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <div className="flex-1 space-y-1">
                      <Skeleton className="h-3.5 w-1/2" />
                      <Skeleton className="h-3 w-3/4" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : recent.length === 0 ? (
              <EmptyState
                title="No activity yet"
                description="Grabs, imports, and other events will show up here."
              />
            ) : (
              <ul>
                {recent.map((h) => {
                  const meta = EVENT_META[h.eventType] ?? { label: h.eventType, tone: "neutral" as Tone };
                  const title = h.seriesTitle ?? h.movieTitle ?? h.sourceTitle ?? "—";
                  return (
                    <li
                      key={h.id}
                      className="flex items-center gap-3 border-t border-zinc-800/60 py-2 first:border-t-0 first:pt-0"
                    >
                      <Badge tone={meta.tone} className="shrink-0">
                        {meta.label}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-zinc-200">{title}</div>
                        {h.sourceTitle && (
                          <div className="truncate font-mono text-xs text-zinc-500">
                            {h.sourceTitle}
                          </div>
                        )}
                      </div>
                      <time className="shrink-0 text-xs text-zinc-500">
                        {new Date(h.date).toLocaleDateString()}
                      </time>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          {/* Storage per root folder */}
          <Card>
            <CardHeader>
              <CardTitle>Storage</CardTitle>
            </CardHeader>
            <CardBody>
              {rootFoldersError ? (
                <EmptyState
                  title="Storage unavailable"
                  description="Free space requires admin access."
                />
              ) : rootFolders === undefined ? (
                <ul className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <li key={i} className="space-y-1">
                      <Skeleton className="h-3.5 w-2/3" />
                      <Skeleton className="h-3 w-1/3" />
                    </li>
                  ))}
                </ul>
              ) : rootFolders.length === 0 ? (
                <EmptyState
                  title="No root folders"
                  description="Add a root folder to store your media."
                />
              ) : (
                <ul>
                  {rootFolders.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-3 border-t border-zinc-800/60 py-2 first:border-t-0 first:pt-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs text-zinc-300">{r.path}</div>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge tone="neutral">{r.mediaType}</Badge>
                          {r.accessible === false && <Badge tone="danger">Inaccessible</Badge>}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm text-zinc-200">{formatBytes(r.freeSpace)}</div>
                        <div className="text-xs text-zinc-500">free</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* System info */}
          <Card>
            <CardHeader>
              <CardTitle>System</CardTitle>
            </CardHeader>
            <CardBody>
              {system ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-zinc-300">
                  <dt className="text-zinc-500">Version</dt>
                  <dd>{system.version}</dd>
                  <dt className="text-zinc-500">Started</dt>
                  <dd>{new Date(system.startedAt).toLocaleString()}</dd>
                  <dt className="text-zinc-500">Config</dt>
                  <dd className="min-w-0 break-all font-mono text-xs">{system.configDir}</dd>
                  <dt className="text-zinc-500">Node</dt>
                  <dd>{system.node}</dd>
                </dl>
              ) : (
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3.5 w-2/3" />
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
