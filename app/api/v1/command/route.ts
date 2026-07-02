import type { NextRequest } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
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
