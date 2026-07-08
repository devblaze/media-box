/**
 * Minimal LLM client for the optional AI assistant (Settings → General → AI
 * assistant). Talks to a local Ollama instance or to OpenRouter — one chat
 * exchange per call, no streaming, no conversation state.
 *
 * The assistant is strictly best-effort: callers must check `aiEnabled()` first
 * and catch every error, so a down/misconfigured model can never break a scan
 * or a request. Never log the OpenRouter API key.
 */
import { getSettings, type AppSettings } from "@/server/settings/settings-service";

const DEFAULT_TIMEOUT_MS = 60_000;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatOpts {
  timeoutMs?: number;
}

/** Whether the AI assistant is configured and usable. */
export function aiEnabled(): boolean {
  const s = getSettings();
  if (s.aiProvider === "ollama") return Boolean(s.ollamaUrl && s.ollamaModel);
  if (s.aiProvider === "openrouter") return Boolean(s.openrouterApiKey && s.openrouterModel);
  return false;
}

/** POST a JSON body, wrapping network failures with a message naming the target. */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  label: string
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} request failed: ${reason}`);
  }
}

/** One chat exchange against the configured provider; returns the raw reply text. */
async function chat(
  s: AppSettings,
  systemPrompt: string,
  userPrompt: string,
  json: boolean,
  opts?: ChatOpts
): Promise<string> {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const signal = AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (s.aiProvider === "ollama") {
    const url = `${s.ollamaUrl.replace(/\/+$/, "")}/api/chat`;
    const res = await postJson(
      url,
      { model: s.ollamaModel, messages, stream: false, ...(json ? { format: "json" } : {}) },
      {},
      signal,
      `Ollama (${url})`
    );
    if (!res.ok) throw new Error(`Ollama (${url}) responded ${res.status}`);
    const data = (await res.json()) as { message?: { content?: unknown } };
    const content = data?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error(`Ollama (${url}) returned no message content`);
    }
    return content;
  }

  if (s.aiProvider === "openrouter") {
    const res = await postJson(
      OPENROUTER_URL,
      {
        model: s.openrouterModel,
        messages,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      },
      { Authorization: `Bearer ${s.openrouterApiKey}` },
      signal,
      "OpenRouter"
    );
    if (!res.ok) throw new Error(`OpenRouter responded ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("OpenRouter returned no message content");
    }
    return content;
  }

  throw new Error('AI assistant is not configured (aiProvider is "none")');
}

/**
 * Parse a model reply as a JSON object, tolerating prose around it: falls back
 * to the first `{ ... last }` block when the whole reply isn't valid JSON.
 */
function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Model wrapped the object in prose/code fences — try the outermost braces.
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(`AI reply was not valid JSON: ${raw.slice(0, 200)}`);
}

/** One chat exchange expected to yield a JSON object (parsed defensively). */
export async function chatJSON(
  systemPrompt: string,
  userPrompt: string,
  opts?: ChatOpts
): Promise<unknown> {
  const raw = await chat(getSettings(), systemPrompt, userPrompt, true, opts);
  return parseJsonObject(raw);
}

/** One chat exchange returning the plain-text reply (e.g. a diagnosis). */
export async function chatText(
  systemPrompt: string,
  userPrompt: string,
  opts?: ChatOpts
): Promise<string> {
  return chat(getSettings(), systemPrompt, userPrompt, false, opts);
}
