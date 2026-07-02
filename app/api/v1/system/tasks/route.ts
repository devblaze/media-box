import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const rows = db
      .select()
      .from(schema.scheduledTasks)
      .orderBy(asc(schema.scheduledTasks.name))
      .all();
    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}
