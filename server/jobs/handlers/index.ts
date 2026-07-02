// Central registration point for all command handlers.
import { registerHandler } from "@/server/jobs/scheduler";
import { housekeeping } from "./housekeeping";
import { refreshSeriesHandler } from "./refresh-series";
import { refreshMoviesHandler } from "./refresh-movies";
import { diskScanHandler } from "./disk-scan";
import { queueMonitorHandler } from "./queue-monitor";
import { fetchTorboxHandler } from "./fetch-torbox";
import { wantedSearchHandler } from "./wanted-search";
import { rssSyncHandler } from "./rss-sync";
import { subtitleSearchHandler } from "./subtitle-search";
import { importDownload } from "@/server/library/importer";

registerHandler("Housekeeping", housekeeping);
registerHandler("RefreshSeries", refreshSeriesHandler);
registerHandler("RefreshMovies", refreshMoviesHandler);
registerHandler("DiskScan", diskScanHandler);
registerHandler("RssSync", rssSyncHandler);
registerHandler("WantedSearch", wantedSearchHandler);
registerHandler("SubtitleSearch", subtitleSearchHandler);
registerHandler("QueueMonitor", queueMonitorHandler, "monitor");
registerHandler("FetchTorboxFiles", async (payload) => {
  return fetchTorboxHandler(payload);
});
registerHandler("ImportDownload", async (payload) => {
  const { downloadId } = payload as { downloadId: number };
  return importDownload(downloadId);
});
registerHandler("ExecuteMigration", async (payload) => {
  const { executeMigration } = await import("@/server/migration/migrate-service");
  return executeMigration(payload as never);
});
