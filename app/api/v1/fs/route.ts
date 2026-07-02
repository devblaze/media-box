import type { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

// Server-side directory browser powering path pickers in the UI.
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const dir = request.nextUrl.searchParams.get("path") || "/";
    const resolved = path.resolve(dir);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return ok({
      path: resolved,
      parent: resolved === "/" ? null : path.dirname(resolved),
      directories,
    });
  } catch (err) {
    return serverError(err);
  }
}
