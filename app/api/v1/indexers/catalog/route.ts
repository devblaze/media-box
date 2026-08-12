import type { NextRequest } from "next/server";
import { listCatalog } from "@/server/indexers/cardigann";
import { requirePermission } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

// Lists the public Cardigann (Jackett/Prowlarr YAML) tracker definitions
// media-box can run natively, for the "add tracker" picker. Definitions are
// fetched from the Prowlarr/Indexers repo and cached on disk, so the first
// call after a cold cache is slow; later ones are instant.
//
// Query params:
//   ?q=          case-insensitive substring match on id/name/description
//   ?supported=true   only definitions this engine can actually run
export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const params = request.nextUrl.searchParams;
    const q = params.get("q")?.trim().toLowerCase() ?? "";
    const supportedOnly = params.get("supported") === "true";

    let entries = await listCatalog();
    if (supportedOnly) entries = entries.filter((e) => e.supported);
    if (q) {
      entries = entries.filter(
        (e) =>
          e.id.toLowerCase().includes(q) ||
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q)
      );
    }
    return ok({ entries });
  } catch (err) {
    return serverError(err);
  }
}
