import type { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { computeNextRun } from "@/server/jobs/scheduler";
import { ok, notFound, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  scheduleKind: z.enum(["interval", "daily", "weekly"]).optional(),
  intervalMinutes: z.coerce.number().int().min(1).max(43200).optional(),
  scheduleHour: z.coerce.number().int().min(0).max(23).nullable().optional(),
  scheduleMinute: z.coerce.number().int().min(0).max(59).nullable().optional(),
  scheduleDay: z.coerce.number().int().min(0).max(6).nullable().optional(),
  enabled: z.boolean().optional(),
});

/** Update a scheduled task's schedule / enabled state and recompute its next run. */
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/system/tasks/[name]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { name } = await ctx.params;
  try {
    const patch = bodySchema.parse(await request.json());
    const db = getDb();
    const existing = db
      .select()
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.name, name))
      .get();
    if (!existing) return notFound("Task not found");

    const merged = { ...existing, ...patch };
    db.update(schema.scheduledTasks)
      .set({ ...patch, nextRunAt: computeNextRun(merged, new Date()) })
      .where(eq(schema.scheduledTasks.name, name))
      .run();

    return ok(
      db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.name, name)).get()
    );
  } catch (err) {
    return serverError(err);
  }
}
