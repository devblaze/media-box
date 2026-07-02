import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return ok(getDb().select().from(schema.namingConfig).get());
  } catch (err) {
    return serverError(err);
  }
}

const patchSchema = z.object({
  renameEpisodes: z.boolean().optional(),
  replaceIllegalCharacters: z.boolean().optional(),
  standardEpisodeFormat: z.string().min(1).optional(),
  seriesFolderFormat: z.string().min(1).optional(),
  seasonFolderFormat: z.string().min(1).optional(),
  movieFormat: z.string().min(1).optional(),
  movieFolderFormat: z.string().min(1).optional(),
});

export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const patch = patchSchema.parse(await request.json());
    const db = getDb();
    db.update(schema.namingConfig).set(patch).where(eq(schema.namingConfig.id, 1)).run();
    return ok(db.select().from(schema.namingConfig).get());
  } catch (err) {
    return serverError(err);
  }
}
