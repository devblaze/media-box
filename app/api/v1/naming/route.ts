/**
 * Read and update the naming configuration (single row, id 1); responses carry the Sonarr/Radarr stock formats as `defaults`.
 */

import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";
import { MULTI_EPISODE_STYLES, SONARR_DEFAULTS } from "@/server/library/naming";

// `defaults` is what a NEW install is created with. It rides along on every
// response so the settings UI can offer "use the Sonarr/Radarr defaults" as a
// deliberate, reviewable action instead of silently rewriting an existing
// library's naming scheme.
function withDefaults(row: typeof schema.namingConfig.$inferSelect | undefined) {
  return row ? { ...row, defaults: SONARR_DEFAULTS } : row;
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return ok(withDefaults(getDb().select().from(schema.namingConfig).get()));
  } catch (err) {
    return serverError(err);
  }
}

const patchSchema = z.object({
  renameEpisodes: z.boolean().optional(),
  replaceIllegalCharacters: z.boolean().optional(),
  standardEpisodeFormat: z.string().min(1).optional(),
  animeEpisodeFormat: z.string().min(1).optional(),
  seriesFolderFormat: z.string().min(1).optional(),
  seasonFolderFormat: z.string().min(1).optional(),
  specialsFolderFormat: z.string().min(1).optional(),
  multiEpisodeStyle: z.enum(MULTI_EPISODE_STYLES).optional(),
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
    return ok(withDefaults(db.select().from(schema.namingConfig).get()));
  } catch (err) {
    return serverError(err);
  }
}
