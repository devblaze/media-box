import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { badRequest, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    return ok(db.select().from(schema.qualityProfiles).orderBy(asc(schema.qualityProfiles.id)).all());
  } catch (err) {
    return serverError(err);
  }
}

const profileSchema = z.object({
  name: z.string().min(1),
  upgradeAllowed: z.boolean().default(true),
  cutoffQualityId: z.number().int(),
  items: z.array(z.object({ qualityId: z.number().int(), allowed: z.boolean() })).min(1),
  preferredTerms: z
    .array(z.object({ term: z.string().min(1), score: z.number().int() }))
    .default([]),
  requiredTerms: z.array(z.string().min(1)).default([]),
  ignoredTerms: z.array(z.string().min(1)).default([]),
});

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const input = profileSchema.parse(await request.json());
    if (!input.items.some((i) => i.allowed && i.qualityId === input.cutoffQualityId)) {
      return badRequest("Cutoff must be one of the allowed qualities");
    }
    const db = getDb();
    const row = db.insert(schema.qualityProfiles).values(input).returning().get();
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
