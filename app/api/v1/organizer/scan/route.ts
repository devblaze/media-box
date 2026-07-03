import type { NextRequest } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { scanDownloads } from "@/server/library/organizer-service";
import { getSettings } from "@/server/settings/settings-service";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scan the configured downloads folder for loose video files, classify each and
 * match it to a library title. Returns `{ root, items }`.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const root = getSettings().downloadsPath;
    const items = await scanDownloads();
    return ok({ root, items });
  } catch (err) {
    return serverError(err);
  }
}
