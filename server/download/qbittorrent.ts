import parseTorrent from "parse-torrent";
import { describeFetchFailure } from "@/lib/fetch-error";
import { infoHashFromMagnet, resolveTorrentSource } from "./torrent-source";
import type {
  AddDownloadRequest,
  ClientItem,
  ClientItemStatus,
  DownloadClient,
  QbittorrentSettings,
} from "./client";

interface QbtTorrentInfo {
  hash: string;
  name: string;
  size: number;
  amount_left: number;
  state: string;
  content_path: string;
  save_path: string;
}

function mapState(state: string): ClientItemStatus {
  switch (state) {
    case "uploading":
    case "stalledUP":
    case "pausedUP":
    case "stoppedUP":
    case "queuedUP":
    case "forcedUP":
      return "localComplete";
    case "downloading":
    case "forcedDL":
    case "metaDL":
    case "checkingDL":
    case "checkingUP":
    case "moving":
      return "downloading";
    case "queuedDL":
    case "allocating":
      return "queued";
    case "stalledDL":
      return "stalled";
    case "error":
    case "missingFiles":
      return "error";
    default:
      return "downloading";
  }
}

export class QbittorrentClient implements DownloadClient {
  readonly type = "qbittorrent" as const;
  private sid: string | null = null;

  constructor(private settings: QbittorrentSettings) {}

  private get baseUrl(): string {
    const proto = this.settings.useSsl ? "https" : "http";
    return `${proto}://${this.settings.host}:${this.settings.port}`;
  }

  /**
   * fetch() with a timeout and HUMAN-READABLE failures: a bare "fetch failed" /
   * "operation was aborted" tells the admin nothing — say what we were doing and
   * where, so a down/unreachable/overloaded qBittorrent is obvious from the log.
   */
  private async fetchQbt(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(
          `qBittorrent did not respond within ${Math.round(timeoutMs / 1000)}s (${what}) — it may be overloaded or unreachable at ${this.baseUrl}`
        );
      }
      const cause = describeFetchFailure(err, this.baseUrl);
      throw new Error(
        `Cannot reach qBittorrent at ${this.baseUrl} (${what})${cause ? ` — ${cause}` : ""} — check host/port and that the WebUI is enabled`,
        { cause: err }
      );
    }
  }

  private async login(): Promise<void> {
    const res = await this.fetchQbt(
      `${this.baseUrl}/api/v2/auth/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: this.settings.username,
          password: this.settings.password,
        }),
      },
      30_000,
      "login"
    );
    const text = await res.text();
    if (!res.ok || text.trim() !== "Ok.") {
      throw new Error(`qBittorrent login failed (${res.status}): ${text.slice(0, 100)}`);
    }
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/SID=([^;]+)/);
    if (!match) throw new Error("qBittorrent login did not return a session cookie");
    this.sid = match[1];
  }

  private async request(path: string, init?: RequestInit, retry = true): Promise<Response> {
    if (!this.sid) await this.login();
    const res = await this.fetchQbt(
      `${this.baseUrl}${path}`,
      { ...init, headers: { ...init?.headers, Cookie: `SID=${this.sid}` } },
      30_000,
      path
    );
    if (res.status === 403 && retry) {
      this.sid = null;
      return this.request(path, init, false);
    }
    if (!res.ok) throw new Error(`qBittorrent ${path} responded ${res.status}`);
    return res;
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await this.request("/api/v2/app/version");
      const version = await res.text();
      return { ok: true, message: `qBittorrent ${version}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async add(req: AddDownloadRequest): Promise<{ externalId: string }> {
    const form = new FormData();
    form.set("category", req.category);
    if (req.savePath) form.set("savepath", req.savePath);

    let infoHash: string | undefined;
    if (req.magnetUrl) {
      form.set("urls", req.magnetUrl);
      const m = req.magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/);
      if (m) infoHash = m[1].toLowerCase();
    } else if (req.torrentFileUrl) {
      try {
        // The link may resolve to a magnet rather than a file — Jackett redirects
        // to one for every magnet-only tracker (see torrent-source.ts).
        const source = await resolveTorrentSource(req.torrentFileUrl);
        if (source.kind === "magnet") {
          infoHash = infoHashFromMagnet(source.magnetUrl);
          form.set("urls", source.magnetUrl);
        } else {
          // Parse the file ourselves so the infohash is known before we hand it
          // over — the queue is correlated back to the client by that hash.
          const parsed = await parseTorrent(source.buffer);
          infoHash = typeof parsed.infoHash === "string" ? parsed.infoHash.toLowerCase() : undefined;
          form.set(
            "torrents",
            new Blob([new Uint8Array(source.buffer)], { type: "application/x-bittorrent" }),
            "release.torrent"
          );
        }
      } catch (err) {
        // Dead/expired link (404s and indexer timeouts are common) — fall back to
        // a magnet synthesized from the announced infohash so the grab can still
        // succeed via DHT/trackers. Without one there is nothing to fall back TO.
        if (!req.infoHash) {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${why}, and the release carries no infohash to build a magnet from`,
            { cause: err }
          );
        }
        infoHash = req.infoHash.toLowerCase();
        form.set("urls", `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(req.title)}`);
      }
    } else {
      throw new Error("Neither magnetUrl nor torrentFileUrl provided");
    }

    if (!infoHash) throw new Error("Could not determine torrent infohash");

    const res = await this.request("/api/v2/torrents/add", { method: "POST", body: form });
    const text = await res.text();
    if (text.trim() === "Fails.") throw new Error("qBittorrent rejected the torrent");
    return { externalId: infoHash };
  }

  async getItems(): Promise<ClientItem[]> {
    const res = await this.request(
      `/api/v2/torrents/info?category=${encodeURIComponent(this.settings.category)}`
    );
    const torrents = (await res.json()) as QbtTorrentInfo[];
    return torrents.map((t) => ({
      externalId: t.hash.toLowerCase(),
      title: t.name,
      size: t.size,
      sizeLeft: t.amount_left,
      status: mapState(t.state),
      savePath: t.content_path || t.save_path,
      message: t.state === "error" ? `qBittorrent state: ${t.state}` : undefined,
    }));
  }

  async remove(externalId: string, deleteData: boolean): Promise<void> {
    const params = new URLSearchParams({
      hashes: externalId,
      deleteFiles: String(deleteData),
    });
    await this.request(`/api/v2/torrents/delete?${params}`, { method: "POST" });
  }
}
