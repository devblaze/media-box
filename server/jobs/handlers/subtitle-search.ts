import {
  wantedSubtitles,
  downloadSubtitleFor,
  type SubtitleScope,
} from "@/server/subtitles/subtitle-service";
import { getSettings } from "@/server/settings/settings-service";

const DELAY_MS = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Downloads missing subtitles in the configured languages. The scheduled full
 * scan (no payload) fills the backlog slowly — capped at `maxBacklogGrabsPerRun`
 * per run — while a targeted run ({ movieId } / { episodeId }, e.g. right after
 * an import) is uncapped.
 */
export async function subtitleSearchHandler(payload: unknown): Promise<string> {
  const p = payload as { movieId?: number; episodeId?: number; seriesId?: number } | null;
  const scope: SubtitleScope | undefined = p?.movieId
    ? { kind: "movie", id: p.movieId }
    : p?.episodeId
      ? { kind: "episode", id: p.episodeId }
      : p?.seriesId
        ? { kind: "series", id: p.seriesId }
        : undefined;

  const wanted = wantedSubtitles(scope);
  if (wanted.length === 0) return "no wanted subtitles";

  const isBacklog = !scope;
  const maxGrabs = getSettings().maxBacklogGrabsPerRun;
  const cap = isBacklog && maxGrabs > 0 ? maxGrabs : Infinity;

  let downloaded = 0;
  let searched = 0;
  for (const w of wanted) {
    searched++;
    try {
      if (await downloadSubtitleFor(w.target, w.language)) downloaded++;
    } catch (err) {
      console.warn(
        `[subtitle-search] ${w.target.kind} ${w.target.id} ${w.language} failed:`,
        err
      );
    }
    await sleep(DELAY_MS);
    if (downloaded >= cap) break;
  }
  return `searched ${searched} targets, downloaded ${downloaded}`;
}
