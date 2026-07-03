import type { NextRequest } from "next/server";
import { z } from "zod";
import { importFromBazarr } from "@/server/migration/bazarr-client";
import { setSetting } from "@/server/settings/settings-service";
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
    const result = await importFromBazarr({ baseUrl: url, apiKey });
    // Import worked — remember the credentials for prefill next time.
    setSetting("bazarrUrl", url);
    setSetting("bazarrApiKey", apiKey);
    return ok(result);
  } catch (err) {
    return serverError(err);
  }
}
