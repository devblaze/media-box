import type { NextRequest } from "next/server";
import { listBuiltins } from "@/server/indexers/builtin/registry";
import { requirePermission } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

// Lists the built-in scrapers that ship with media-box, for the "add built-in
// indexer" picker. No secrets — just display metadata.
export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    return ok(listBuiltins());
  } catch (err) {
    return serverError(err);
  }
}
