import type { NextRequest } from "next/server";
import { requirePermission } from "@/server/auth/guards";
import { listFileChanges, pruneDuplicateFileChanges } from "@/server/library/file-change-service";
import { ok, serverError } from "@/lib/http";

const STATUSES = ["pending", "approved", "declined", "applied", "failed"] as const;
type Status = (typeof STATUSES)[number];

/**
 * One page of file changes held for approval in Ask mode, newest first.
 * Paged (`limit`/`offset`) because the table can hold tens of thousands of rows.
 * Requires the `files.approve` permission (admins always).
 */
export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "files.approve");
  if (denied) return denied;
  try {
    const sp = request.nextUrl.searchParams;
    const statusParam = sp.get("status");
    const status = STATUSES.includes(statusParam as Status) ? (statusParam as Status) : undefined;
    return ok(
      listFileChanges({
        status,
        limit: Number(sp.get("limit")) || undefined,
        offset: Number(sp.get("offset")) || undefined,
      })
    );
  } catch (err) {
    return serverError(err);
  }
}

/**
 * Housekeeping: drop duplicate pending changes (same operation offered again by
 * a retrying job), keeping the newest of each.
 */
export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "files.approve");
  if (denied) return denied;
  try {
    return ok({ removed: pruneDuplicateFileChanges() });
  } catch (err) {
    return serverError(err);
  }
}
