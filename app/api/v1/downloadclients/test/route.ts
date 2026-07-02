import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getClient } from "@/server/download/client";
import { clientBodySchema } from "../route";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

const bodySchema = z.union([
  z.object({ id: z.number().int() }), // test a saved client (uses stored secrets)
  clientBodySchema, // test unsaved settings
]);

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await request.json());
    let row;
    if ("id" in body) {
      row = getDb()
        .select()
        .from(schema.downloadClients)
        .where(eq(schema.downloadClients.id, body.id))
        .get();
      if (!row) return ok({ ok: false, message: "Client not found" });
    } else {
      row = {
        id: 0,
        name: body.name,
        type: body.type,
        settings: body.settings,
        enabled: true,
        priority: 1,
        removeCompletedDownloads: true,
      };
    }
    try {
      const client = await getClient(row);
      return ok(await client.test());
    } catch (err) {
      return ok({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    return serverError(err);
  }
}
