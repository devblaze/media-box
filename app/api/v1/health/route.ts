import { sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { ok, serverError } from "@/lib/http";

export async function GET() {
  try {
    getDb().run(sql`SELECT 1`);
    return ok({ status: "healthy" });
  } catch (err) {
    return serverError(err);
  }
}
