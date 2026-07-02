import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

const profileSchema = z.object({
  name: z.string().min(1),
  upgradeAllowed: z.boolean(),
  cutoffQualityId: z.number().int(),
  items: z.array(z.object({ qualityId: z.number().int(), allowed: z.boolean() })).min(1),
  preferredTerms: z
    .array(z.object({ term: z.string().min(1), score: z.number().int() }))
    .default([]),
  requiredTerms: z.array(z.string().min(1)).default([]),
  ignoredTerms: z.array(z.string().min(1)).default([]),
});

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/qualityprofiles/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const profileId = Number(id);
    const db = getDb();
    const existing = db
      .select()
      .from(schema.qualityProfiles)
      .where(eq(schema.qualityProfiles.id, profileId))
      .get();
    if (!existing) return notFound("Profile not found");
    const input = profileSchema.parse(await request.json());
    if (!input.items.some((i) => i.allowed && i.qualityId === input.cutoffQualityId)) {
      return badRequest("Cutoff must be one of the allowed qualities");
    }
    db.update(schema.qualityProfiles).set(input).where(eq(schema.qualityProfiles.id, profileId)).run();
    return ok(
      db.select().from(schema.qualityProfiles).where(eq(schema.qualityProfiles.id, profileId)).get()
    );
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/qualityprofiles/[id]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const profileId = Number(id);
    if (!Number.isInteger(profileId)) return badRequest("Invalid id");
    const db = getDb();
    const seriesUsing = db
      .select({ id: schema.series.id })
      .from(schema.series)
      .where(eq(schema.series.qualityProfileId, profileId))
      .get();
    const moviesUsing = db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(eq(schema.movies.qualityProfileId, profileId))
      .get();
    if (seriesUsing || moviesUsing) return badRequest("Profile is in use by library items");
    db.delete(schema.qualityProfiles).where(eq(schema.qualityProfiles.id, profileId)).run();
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
