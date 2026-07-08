import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getCaps } from "@/server/indexers/torznab";
import { ok, serverError } from "@/lib/http";
import { requirePermission } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const db = getDb();
    return ok(db.select().from(schema.indexers).orderBy(asc(schema.indexers.priority)).all());
  } catch (err) {
    return serverError(err);
  }
}

export const indexerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  apiKey: z.string().nullable().optional(),
  categories: z.array(z.number().int()).optional(),
  enableRss: z.boolean().optional(),
  enableAutomaticSearch: z.boolean().optional(),
  enableInteractiveSearch: z.boolean().optional(),
  minimumSeeders: z.number().int().min(0).optional(),
  priority: z.number().int().min(1).max(50).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const input = indexerSchema.parse(await request.json());
    // discover capabilities on save
    let supportsTv = true;
    let supportsMovies = true;
    try {
      const caps = await getCaps(input.url, input.apiKey ?? null);
      supportsTv = caps.tvSearchAvailable;
      supportsMovies = caps.movieSearchAvailable;
    } catch {
      // keep defaults if caps probing fails; Test button reports errors explicitly
    }
    const db = getDb();
    const row = db
      .insert(schema.indexers)
      .values({ ...input, apiKey: input.apiKey ?? null, supportsTv, supportsMovies })
      .returning()
      .get();
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
