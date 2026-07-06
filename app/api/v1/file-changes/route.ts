import type { NextRequest } from "next/server";
import { requirePermission } from "@/server/auth/guards";
import { listFileChanges } from "@/server/library/file-change-service";
import { ok, serverError } from "@/lib/http";

/**
 * List file changes held for approval in Ask mode (pending + recently decided),
 * newest first. Requires the `files.approve` permission (admins always).
 */
export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "files.approve");
  if (denied) return denied;
  try {
    return ok(listFileChanges());
  } catch (err) {
    return serverError(err);
  }
}
