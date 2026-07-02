import { z } from "zod";

export interface AddDownloadRequest {
  magnetUrl?: string;
  torrentFileUrl?: string;
  title: string;
  category: string;
  savePath?: string;
}

export type ClientItemStatus =
  | "queued"
  | "downloading"
  | "remoteCompleted" // finished on the remote service (TorBox), not yet local
  | "localComplete"
  | "stalled"
  | "error";

export interface ClientItem {
  externalId: string;
  title: string;
  size: number;
  sizeLeft: number;
  status: ClientItemStatus;
  /** path where the client put the data, in the client's own filesystem view */
  savePath?: string;
  message?: string;
}

export interface DownloadClient {
  readonly type: "qbittorrent" | "torbox";
  test(): Promise<{ ok: boolean; message?: string }>;
  add(req: AddDownloadRequest): Promise<{ externalId: string }>;
  getItems(): Promise<ClientItem[]>;
  remove(externalId: string, deleteData: boolean): Promise<void>;
}

export const qbittorrentSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(8080),
  useSsl: z.boolean().default(false),
  username: z.string().default(""),
  password: z.string().default(""),
  category: z.string().default("media-box"),
});
export type QbittorrentSettings = z.infer<typeof qbittorrentSettingsSchema>;

export const torboxSettingsSchema = z.object({
  apiKey: z.string().min(1),
  /** local directory TorBox files are fetched into before import */
  stagingDir: z.string().default("/data/torbox"),
});
export type TorboxSettings = z.infer<typeof torboxSettingsSchema>;

export interface DownloadClientRow {
  id: number;
  name: string;
  type: "qbittorrent" | "torbox";
  settings: unknown;
  enabled: boolean;
  priority: number;
  removeCompletedDownloads: boolean;
}

export async function getClient(row: DownloadClientRow): Promise<DownloadClient> {
  if (row.type === "qbittorrent") {
    const { QbittorrentClient } = await import("./qbittorrent");
    return new QbittorrentClient(qbittorrentSettingsSchema.parse(row.settings));
  }
  const { TorboxClient } = await import("./torbox");
  return new TorboxClient(torboxSettingsSchema.parse(row.settings));
}
