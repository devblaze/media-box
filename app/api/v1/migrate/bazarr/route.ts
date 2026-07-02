import type { NextRequest } from "next/server";
import { z } from "zod";
import { importFromBazarr } from "@/server/migration/bazarr-client";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export const runtime = "nodejs";

const bodySchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
});

// POST = connect to Bazarr and import its subtitle configuration into settings.
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { url, apiKey } = bodySchema.parse(await request.json());
    return ok(await importFromBazarr({ baseUrl: url, apiKey }));
  } catch (err) {
    return serverError(err);
  }
}
