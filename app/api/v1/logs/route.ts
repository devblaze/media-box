import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const params = request.nextUrl.searchParams;

    const levelParam = params.get("level");
    const level = LEVELS.includes(levelParam as Level) ? (levelParam as Level) : undefined;

    const parsedLimit = Number(params.get("limit"));
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const rows = db
      .select()
      .from(schema.logEntries)
      .where(level ? eq(schema.logEntries.level, level) : undefined)
      .orderBy(desc(schema.logEntries.id))
      .limit(limit)
      .all();

    return ok(rows);
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
