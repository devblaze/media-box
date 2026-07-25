import type { NextRequest } from "next/server";
import { getDb, schema } from "@/server/db";
import { listLogs } from "@/server/logging/logger";
import { requireAdmin } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Paginated log entries, newest first: `{ entries, total, limit, offset }`.
 * `total` counts every row matching the level filter so the UI can page.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const params = request.nextUrl.searchParams;

    const levelParam = params.get("level");
    const level = LEVELS.includes(levelParam as Level) ? (levelParam as Level) : undefined;

    const parsedLimit = Number(params.get("limit"));
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const parsedOffset = Number(params.get("offset"));
    const offset = Number.isFinite(parsedOffset) ? Math.max(Math.trunc(parsedOffset), 0) : 0;

    const { entries, total } = listLogs({ level, limit, offset });
    return ok({ entries, total, limit, offset });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    getDb().delete(schema.logEntries).run();
    return ok({ cleared: true });
  } catch (err) {
    return serverError(err);
  }
}
