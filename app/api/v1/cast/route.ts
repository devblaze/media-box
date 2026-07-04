import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/guards";
import { getOrCreateKioskToken } from "@/server/settings/settings-service";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The shared cast token, for building tokenized media URLs a cast device can
 * fetch without a cookie (Chromecast/AirPlay `?key=`, and the /tv "Play on TV"
 * links). Any signed-in user may read it (it grants only user-level streaming);
 * admins rotate it via `POST /api/v1/kiosk`.
 */
export async function GET(request: NextRequest) {
  const denied = requireUser(request);
  if (denied) return denied;
  return ok({ token: getOrCreateKioskToken() });
}
