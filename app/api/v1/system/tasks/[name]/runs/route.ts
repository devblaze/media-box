import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent runs (command history) for a scheduled task — its "logs" / output. */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/v1/system/tasks/[name]/runs">
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { name } = await ctx.params;
  try {
    const rows = getDb()
      .select({
        id: schema.commands.id,
        status: schema.commands.status,
        trigger: schema.commands.trigger,
        queuedAt: schema.commands.queuedAt,
        startedAt: schema.commands.startedAt,
        endedAt: schema.commands.endedAt,
        result: schema.commands.result,
        error: schema.commands.error,
      })
      .from(schema.commands)
      .where(eq(schema.commands.name, name))
      .orderBy(desc(schema.commands.queuedAt))
      .limit(30)
      .all();
    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}
