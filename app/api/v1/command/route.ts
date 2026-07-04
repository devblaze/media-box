import type { NextRequest } from "next/server";
import { count, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

const MAX_PAGE_SIZE = 100;

/**
 * List commands, newest first.
 *
 * - Default (no params): the newest 50 as a flat array — back-compat for the
 *   dashboard notifier, batch-import poller, etc.
 * - Paginated (opt-in via `?page`): `{ items, total, page, pageSize }` so the
 *   Tasks page can page through a large history (a mass re-import can queue
 *   thousands of commands) without rendering all of them at once.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const sp = request.nextUrl.searchParams;
    const pageParam = sp.get("page");

    if (pageParam !== null) {
      const page = Math.max(0, Math.floor(Number(pageParam)) || 0);
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Math.floor(Number(sp.get("pageSize")) || 20))
      );
      const total = db.select({ n: count() }).from(schema.commands).get()?.n ?? 0;
      const items = db
        .select()
        .from(schema.commands)
        .orderBy(desc(schema.commands.queuedAt))
        .limit(pageSize)
        .offset(page * pageSize)
        .all();
      return ok({ items, total, page, pageSize });
    }

    const rows = db
      .select()
      .from(schema.commands)
      .orderBy(desc(schema.commands.queuedAt))
      .limit(50)
      .all();
    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}

const bodySchema = z.object({
  name: z.string().min(1),
  payload: z.unknown().optional(),
});

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { name, payload } = bodySchema.parse(await request.json());
    const id = enqueueCommand(name, payload ?? null, "manual", 10);
    return ok({ id, queued: id !== null }, { status: id === null ? 200 : 201 });
  } catch (err) {
    return serverError(err);
  }
}
