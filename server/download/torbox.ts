import type {
  AddDownloadRequest,
  ClientItem,
  ClientItemStatus,
  DownloadClient,
  TorboxSettings,
} from "./client";

const API_BASE = "https://api.torbox.app/v1/api";

interface TorboxTorrent {
  id: number;
  hash: string;
  name: string;
  size: number;
  progress: number; // 0..1
  download_state: string;
  download_finished: boolean;
  download_present: boolean;
  files?: { id: number; name: string; size: number; short_name?: string }[];
}

interface TorboxResponse<T> {
  success: boolean;
  error?: string | null;
  detail?: string;
  data: T;
}

function mapState(t: TorboxTorrent): ClientItemStatus {
  if (t.download_finished && t.download_present) return "remoteCompleted";
  switch (t.download_state) {
    case "downloading":
    case "metaDL":
    case "checkingResumeData":
      return "downloading";
    case "stalled":
    case "stalled (no seeds)":
      return "stalled";
    case "error":
    case "failed":
      return "error";
    case "queued":
    case "paused":
      return "queued";
    default:
      return "downloading";
  }
}

export class TorboxClient implements DownloadClient {
  readonly type = "torbox" as const;

  constructor(readonly settings: TorboxSettings) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as TorboxResponse<T> | null;
    if (!res.ok || !body?.success) {
      throw new Error(`TorBox ${path}: ${body?.detail ?? body?.error ?? `HTTP ${res.status}`}`);
    }
    return body.data;
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.request("/user/me?settings=false");
      return { ok: true, message: "TorBox account OK" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async add(req: AddDownloadRequest): Promise<{ externalId: string }> {
    const form = new FormData();
    if (req.magnetUrl) {
      form.set("magnet", req.magnetUrl);
    } else if (req.torrentFileUrl) {
      const torrentRes = await fetch(req.torrentFileUrl, {
        signal: AbortSignal.timeout(30_000),
        headers: { "User-Agent": "media-box/0.1" },
        redirect: "follow",
      });
      if (!torrentRes.ok) throw new Error(`Failed to fetch .torrent (${torrentRes.status})`);
      const buffer = Buffer.from(await torrentRes.arrayBuffer());
      form.set("file", new Blob([new Uint8Array(buffer)], { type: "application/x-bittorrent" }), "release.torrent");
    } else {
      throw new Error("Neither magnetUrl nor torrentFileUrl provided");
    }
    form.set("name", req.title);

    const data = await this.request<{ torrent_id: number }>("/torrents/createtorrent", {
      method: "POST",
      body: form,
    });
    return { externalId: String(data.torrent_id) };
  }

  async getItems(): Promise<ClientItem[]> {
    const data = await this.request<TorboxTorrent[]>("/torrents/mylist?bypass_cache=true");
    return (data ?? []).map((t) => ({
      externalId: String(t.id),
      title: t.name,
      size: t.size,
      sizeLeft: Math.round(t.size * (1 - (t.progress ?? 0))),
      status: mapState(t),
      message: t.download_state === "error" ? "TorBox reported an error" : undefined,
    }));
  }

  async remove(externalId: string): Promise<void> {
    await this.request("/torrents/controltorrent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ torrent_id: Number(externalId), operation: "delete" }),
    });
  }

  /** List files of a remote torrent (used by the Phase 3 fetch job). */
  async getFiles(externalId: string): Promise<{ id: number; name: string; size: number }[]> {
    const data = await this.request<TorboxTorrent[]>(
      `/torrents/mylist?id=${externalId}&bypass_cache=true`
    );
    const torrent = Array.isArray(data) ? data[0] : (data as unknown as TorboxTorrent);
    return (torrent?.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.size }));
  }

  /** Request a time-limited download URL for one file of a torrent. */
  async getDownloadUrl(externalId: string, fileId: number): Promise<string> {
    const data = await this.request<string>(
      `/torrents/requestdl?token=${encodeURIComponent(this.settings.apiKey)}&torrent_id=${externalId}&file_id=${fileId}`
    );
    if (typeof data !== "string" || !data.startsWith("http")) {
      throw new Error("TorBox did not return a download URL");
    }
    return data;
  }
}
