import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getClient } from "@/server/download/client";
import { clientBodySchema, mergeSecrets } from "../route";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const raw = (await request.json()) as Record<string, unknown>;
    const db = getDb();

    // `{ id }` with no settings → test a saved client using its stored secrets.
    if (raw.settings === undefined && typeof raw.id === "number") {
      const row = db
        .select()
        .from(schema.downloadClients)
        .where(eq(schema.downloadClients.id, raw.id))
        .get();
      if (!row) return ok({ ok: false, message: "Client not found" });
      return await runTest(row);
    }

    // Testing edited settings. When they belong to a saved client (an `id` rides
    // along), resolve any secret that is still the redaction placeholder back to
    // the stored value — otherwise a Test after editing sends "••••••••" as the
    // credential (which, being non-latin1, even throws when set as an HTTP header).
    if (typeof raw.id === "number" && raw.settings && typeof raw.settings === "object") {
      const stored = db
        .select()
        .from(schema.downloadClients)
        .where(eq(schema.downloadClients.id, raw.id))
        .get();
      if (stored) {
        raw.settings = mergeSecrets(
          stored.settings as Record<string, unknown>,
          raw.settings as Record<string, unknown>
        );
      }
    }

    const parsed = clientBodySchema.parse(raw); // extra `id` key is ignored
    return await runTest({
      id: 0,
      name: parsed.name,
      type: parsed.type,
      settings: parsed.settings,
      enabled: true,
      priority: 1,
      removeCompletedDownloads: true,
    });
  } catch (err) {
    return serverError(err);
  }
}

async function runTest(row: Parameters<typeof getClient>[0]) {
  try {
    const client = await getClient(row);
    return ok(await client.test());
  } catch (err) {
    return ok({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}
