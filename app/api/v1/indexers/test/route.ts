import type { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/server/auth/guards";
import { testIndexer } from "@/server/indexers/test-indexer";
import { ok, serverError } from "@/lib/http";

const bodySchema = z.object({
  type: z.enum(["torznab", "builtin"]).optional(),
  url: z.string().optional(),
  apiKey: z.string().nullable().optional(),
  definition: z.string().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await request.json());
    const result = await testIndexer({
      type: body.type ?? "torznab",
      definition: body.definition ?? null,
      url: body.url ?? "",
      apiKey: body.apiKey ?? null,
    });
    // Kept HTTP 200 even on failure — success/failure is in the body (as before).
    return ok({
      ok: result.ok,
      message: result.message,
      latencyMs: result.latencyMs,
      caps: result.caps,
    });
  } catch (err) {
    return serverError(err);
  }
}
