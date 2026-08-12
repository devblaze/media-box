import type { NextRequest } from "next/server";
import { getDb, schema } from "@/server/db";
import { requirePermission } from "@/server/auth/guards";
import { testIndexer } from "@/server/indexers/test-indexer";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Probe every configured indexer concurrently — one click instead of opening each. */
export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const rows = getDb().select().from(schema.indexers).all();
    const results = await Promise.all(
      rows.map(async (r) => {
        const res = await testIndexer({
          type: r.type,
          definition: r.definition,
          url: r.url,
          apiKey: r.apiKey,
        });
        return {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          ok: res.ok,
          message: res.message,
          latencyMs: res.latencyMs,
        };
      })
    );
    return ok({ results });
  } catch (err) {
    return serverError(err);
  }
}
