import type { NextRequest } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { ALL_PROVIDERS, enabledProviderIds } from "@/server/subtitles/providers/registry";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All known subtitle providers + which are enabled/ready — drives the settings UI. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const enabled = new Set(enabledProviderIds());
    return ok(
      ALL_PROVIDERS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        needsConfig: p.needsConfig,
        specializes: p.specializes ?? [],
        enabled: enabled.has(p.id),
        ready: p.isReady(),
      }))
    );
  } catch (err) {
    return serverError(err);
  }
}
