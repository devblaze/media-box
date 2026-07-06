import { schema } from "@/server/db";

/**
 * The coarse lifecycle stage shown as a request's status badge. It refines the
 * stored `requests.status` (pending/approved/declined/available) for APPROVED
 * requests by folding in the live state of the download that fulfils them:
 *
 *   pending → (approved) searching → queued → downloading → importing → available
 *                                              ↘ failed
 *
 * `searching` is "approved, but no release grabbed yet" — the wanted-search job
 * keeps retrying on a schedule, so this is a normal waiting state, not terminal.
 */
export type RequestStage =
  | "pending"
  | "searching"
  | "queued"
  | "downloading"
  | "importing"
  | "available"
  | "failed"
  | "declined";

type DownloadStatus = (typeof schema.downloads.$inferSelect)["status"];

/** Fold a live `downloads.status` into the coarse request stage. */
export function stageFromDownload(status: DownloadStatus): RequestStage {
  switch (status) {
    case "queued":
      return "queued";
    case "downloading":
      return "downloading";
    case "remoteCompleted":
    case "fetching":
    case "importPending":
    case "importing":
    case "imported":
      return "importing";
    case "failed":
    case "warning":
      return "failed";
    default:
      return "downloading";
  }
}
