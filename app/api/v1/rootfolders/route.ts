import type { NextRequest } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const rows = db.select().from(schema.rootFolders).all();
    return ok(
      rows.map((r) => {
        let accessible = false;
        let freeSpace: number | null = null;
        try {
          fs.accessSync(r.path, fs.constants.W_OK);
          accessible = true;
          freeSpace = fs.statfsSync(r.path).bavail * fs.statfsSync(r.path).bsize;
        } catch {
          // reported as inaccessible below
        }
        return { ...r, accessible, freeSpace };
      })
    );
  } catch (err) {
    return serverError(err);
  }
}

const addSchema = z.object({
  path: z.string().min(1),
  mediaType: z.enum(["series", "movies", "anime"]),
});

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const input = addSchema.parse(await request.json());
    if (!fs.existsSync(input.path)) {
      fs.mkdirSync(input.path, { recursive: true });
    }
    const db = getDb();
    const row = db.insert(schema.rootFolders).values(input).returning().get();
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
