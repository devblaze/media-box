import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { getSettings } from "@/server/settings/settings-service";
import { aiEnabled, chatText } from "@/server/ai/llm";
import { APP_VERSION } from "@/lib/version";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";

const bodySchema = z.object({
  question: z.string().optional(),
});

const SYSTEM_PROMPT =
  "You are the built-in diagnostic assistant of media-box, a self-hosted PVR (Sonarr/Radarr-like). " +
  "Analyse the context and the user's question, identify likely root causes, and give concrete " +
  "numbered fix steps. Be specific to the evidence; say when you're unsure.";

// Server-gathered diagnostic context. Settings go in as booleans/enums ONLY —
// never secret values (API keys, tokens, passwords stay out of the prompt).
function gatherContext(): Record<string, unknown> {
  const db = getDb();
  const s = getSettings();

  const settings = {
    logLevel: s.logLevel,
    importMode: s.importMode,
    fileOperationsMode: s.fileOperationsMode,
    transcodeHwAccel: s.transcodeHwAccel,
    maxTranscodeSessions: s.maxTranscodeSessions,
    maxBacklogGrabsPerRun: s.maxBacklogGrabsPerRun,
    requestsAutoApprove: s.requestsAutoApprove,
    aiProvider: s.aiProvider,
    tmdbApiKeyConfigured: Boolean(s.tmdbApiKey),
    downloadsPathConfigured: Boolean(s.downloadsPath),
    moviesPathConfigured: Boolean(s.moviesPath),
    seriesPathConfigured: Boolean(s.seriesPath),
    animePathConfigured: Boolean(s.animePath),
    subtitleLanguages: s.subtitleLanguages,
    subtitleProviders: s.subtitleProviders,
    pushoverConfigured: Boolean(s.pushoverAppToken),
  };

  const recentWarningsAndErrors = db
    .select({
      level: schema.logEntries.level,
      source: schema.logEntries.source,
      message: schema.logEntries.message,
      createdAt: schema.logEntries.createdAt,
    })
    .from(schema.logEntries)
    .where(inArray(schema.logEntries.level, ["warn", "error"]))
    .orderBy(desc(schema.logEntries.id))
    .limit(40)
    .all();

  // Active + failed downloads (everything not yet imported), newest first.
  const downloads = db
    .select({
      title: schema.downloads.title,
      status: schema.downloads.status,
      statusMessage: schema.downloads.statusMessage,
      grabbedAt: schema.downloads.grabbedAt,
    })
    .from(schema.downloads)
    .where(
      inArray(schema.downloads.status, [
        "queued",
        "downloading",
        "remoteCompleted",
        "fetching",
        "importPending",
        "importing",
        "warning",
        "failed",
      ])
    )
    .orderBy(desc(schema.downloads.grabbedAt))
    .limit(10)
    .all();

  const downloadClients = db
    .select({ name: schema.downloadClients.name, type: schema.downloadClients.type })
    .from(schema.downloadClients)
    .where(eq(schema.downloadClients.enabled, true))
    .all();

  const indexers = db
    .select({ name: schema.indexers.name })
    .from(schema.indexers)
    .where(eq(schema.indexers.enabled, true))
    .all()
    .map((i) => i.name);

  return {
    appVersion: APP_VERSION,
    settings,
    recentWarningsAndErrors,
    downloads,
    downloadClients,
    indexers,
  };
}

/**
 * Ask the configured AI assistant to diagnose the instance: the model gets the
 * admin's question plus server-gathered context (version, sanitized settings,
 * recent warn/error logs, active/failed downloads, enabled clients/indexers).
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    if (!aiEnabled()) {
      return NextResponse.json(
        { error: "AI assistant is not configured — pick a provider under Settings → General." },
        { status: 503 }
      );
    }
    const { question } = bodySchema.parse(await request.json().catch(() => ({})));
    const context = gatherContext();
    const userPrompt =
      `${question?.trim() || "Diagnose the current state of this media-box instance and point out any problems."}` +
      `\n\nContext (JSON):\n${JSON.stringify(context, null, 2)}`;
    const answer = await chatText(SYSTEM_PROMPT, userPrompt, { timeoutMs: 120_000 });
    return ok({ answer });
  } catch (err) {
    return serverError(err);
  }
}
