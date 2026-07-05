import { resolveMediaPath, type MediaType } from "@/server/library/resolve-media";
import { probeChapters } from "@/server/library/media-info";

/** A skippable stretch (intro/opening or recap) derived from chapter markers. */
export interface SkipSegment {
  type: "intro" | "recap";
  startSeconds: number;
  endSeconds: number;
  label: string;
}

// Chapter-title heuristics. Reliable only when the file actually names its
// chapters (common in anime / TV rips) — we don't guess from timing alone.
const RECAP_RE = /\b(recap|previously)\b/i;
const INTRO_RE = /\b(opening|intro|ncop)\b/i;
const OP_ONLY_RE = /^\s*op\.?\s*\d*\s*$/i; // a chapter literally titled "OP"

function classify(title: string | null): SkipSegment["type"] | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  if (RECAP_RE.test(t)) return "recap";
  if (INTRO_RE.test(t) || OP_ONLY_RE.test(t)) return "intro";
  return null;
}

/**
 * Skippable intro/recap segments for a movie/episode, from its chapter markers.
 * Empty when the file has no (named) chapters or ffprobe is unavailable.
 */
export async function skipSegments(target: { kind: MediaType; id: number }): Promise<SkipSegment[]> {
  const resolved = resolveMediaPath(target.kind, target.id);
  if (!resolved) return [];

  const chapters = await probeChapters(resolved.absPath);
  const segments: SkipSegment[] = [];
  for (const c of chapters) {
    const type = classify(c.title);
    if (!type) continue;
    segments.push({
      type,
      startSeconds: c.startSeconds,
      endSeconds: c.endSeconds,
      label: type === "recap" ? "Skip Recap" : "Skip Intro",
    });
  }
  return segments;
}
