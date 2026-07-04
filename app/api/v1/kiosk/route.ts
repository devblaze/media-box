import type { NextRequest } from "next/server";
import crypto from "node:crypto";
import { requireAdmin } from "@/server/auth/guards";
import { getSettings, setSetting } from "@/server/settings/settings-service";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mintToken(): string {
  const token = crypto.randomBytes(24).toString("hex");
  setSetting("kioskToken", token);
  return token;
}

/** The current kiosk token, minting one on first access (admin only). */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const token = getSettings().kioskToken || mintToken();
  return ok({ token });
}

/** Rotate the kiosk token — invalidates every previously issued cast link (admin). */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return ok({ token: mintToken() });
}
