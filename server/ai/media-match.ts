/**
 * AI-assisted title matching for the Library Import scan. When the heuristic
 * classifier leaves a candidate "unsure", we ask the configured model to either
 * pick the right TMDB suggestion or extract a cleaned-up search query from the
 * messy file/folder name. Best-effort only — the caller catches every error and
 * leaves the candidate untouched on failure.
 */
import { z } from "zod";
import { chatJSON, type ChatOpts } from "./llm";

export interface AiMatchInput {
  type: "movie" | "series" | "anime";
  /** The raw on-disk file or folder name being matched. */
  fileName: string;
  parsedTitle: string;
  parsedYear: number | null;
  suggestions: { tmdbId: number; title: string; year: number | null }[];
}

export interface AiMatchResult {
  /** A suggestion's tmdbId when one is clearly the right title, else null. */
  tmdbId: number | null;
  /** A cleaned-up search query extracted from the name, else null. */
  searchQuery: string | null;
  /** Release year hint for the search query, else null. */
  year: number | null;
}

// Each field degrades to null on a wrong type/missing key rather than failing
// the whole reply — models don't always honour the schema exactly.
const resultSchema = z.object({
  tmdbId: z.number().int().nullable().catch(null),
  searchQuery: z.string().nullable().catch(null),
  year: z.number().int().nullable().catch(null),
});

const SYSTEM_PROMPT = `You match messy media file/folder names to The Movie Database (TMDB).
You are given the raw on-disk name, the title/year a heuristic parser extracted, and a list of TMDB suggestions.
Reply with ONLY a JSON object of this exact shape:
{"tmdbId": number | null, "searchQuery": string | null, "year": number | null}
Rules:
- If one suggestion is clearly the title the name refers to, set "tmdbId" to its tmdbId (and null the other fields).
- Otherwise, if you can extract a cleaner title from the raw name (strip release-group tags, quality, codecs, language markers, etc.), set "searchQuery" to it and "year" to the release year if the name contains one.
- If you are unsure, use null for everything. Never invent a tmdbId that is not in the suggestion list.`;

/** Ask the model to resolve one "unsure" import candidate. Throws on any failure. */
export async function aiResolveCandidate(
  input: AiMatchInput,
  opts?: ChatOpts
): Promise<AiMatchResult> {
  const kind = input.type === "movie" ? "movie" : "TV series";
  const userPrompt = [
    `Media kind: ${kind}${input.type === "anime" ? " (anime)" : ""}`,
    `Raw name: ${input.fileName}`,
    `Parsed title: ${input.parsedTitle}`,
    `Parsed year: ${input.parsedYear ?? "unknown"}`,
    "TMDB suggestions:",
    input.suggestions.length === 0
      ? "(none)"
      : input.suggestions
          .map((s) => `- tmdbId ${s.tmdbId}: "${s.title}" (${s.year ?? "year unknown"})`)
          .join("\n"),
  ].join("\n");

  const raw = await chatJSON(SYSTEM_PROMPT, userPrompt, opts);
  const parsed = resultSchema.parse(raw);
  const searchQuery = parsed.searchQuery?.trim() || null;
  return { tmdbId: parsed.tmdbId, searchQuery, year: parsed.year };
}
