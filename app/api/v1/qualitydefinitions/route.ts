import type { NextRequest } from "next/server";
import { QUALITIES } from "@/server/parser/quality";
import { ok } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return ok([...QUALITIES].sort((a, b) => a.rank - b.rank));
}
