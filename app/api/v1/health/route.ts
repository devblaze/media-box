import { sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { APP_VERSION } from "@/lib/version";
import { ok, serverError } from "@/lib/http";

export async function GET() {
  try {
    getDb().run(sql`SELECT 1`);
    // Version included so a remote check can confirm WHICH build is running
    // (deploy drift is the first suspect when a fixed bug "still happens").
    return ok({ status: "healthy", version: APP_VERSION });
  } catch (err) {
    return serverError(err);
  }
}
