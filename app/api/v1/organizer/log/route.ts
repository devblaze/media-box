import type { NextRequest } from "next/server";
import { requirePermission } from "@/server/auth/guards";
import { getOrganizeLog } from "@/server/library/organizer-service";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES = ["movie", "series", "anime"] as const;
const STATUSES = ["organized", "failed", "skipped"] as const;
type LogType = (typeof TYPES)[number];
type LogStatus = (typeof STATUSES)[number];

/** Newest-first organize log filtered by text query, media type and status. */
export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "organizer.access");
  if (denied) return denied;

  try {
    const params = request.nextUrl.searchParams;
    const typeParam = params.get("type");
    const statusParam = params.get("status");
    const limitParam = Number(params.get("limit"));

    const rows = getOrganizeLog({
      q: params.get("q") ?? undefined,
      type: TYPES.includes(typeParam as LogType) ? (typeParam as LogType) : undefined,
      status: STATUSES.includes(statusParam as LogStatus) ? (statusParam as LogStatus) : undefined,
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
    });
    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}
