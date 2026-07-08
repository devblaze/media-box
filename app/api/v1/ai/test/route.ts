import type { NextRequest } from "next/server";
import { aiEnabled, chatJSON } from "@/server/ai/llm";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export const runtime = "nodejs";

// Tiny round-trip against the configured AI provider so the admin can verify the
// assistant works before relying on it (mirrors settings/transcode-test).
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    if (!aiEnabled()) {
      return ok({
        ok: false,
        message: "AI assistant is not configured — pick a provider and save settings first.",
      });
    }
    try {
      const reply = await chatJSON(
        'You are a connectivity test. Reply with exactly the JSON {"ok":true}.',
        'Reply with the JSON {"ok":true}.',
        { timeoutMs: 30_000 }
      );
      const confirmed =
        typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === true;
      return ok({
        ok: confirmed,
        message: confirmed
          ? "AI provider responded"
          : "AI provider replied, but not with the expected JSON",
      });
    } catch (err) {
      return ok({ ok: false, message: err instanceof Error ? err.message : "AI test failed" });
    }
  } catch (err) {
    return serverError(err);
  }
}
