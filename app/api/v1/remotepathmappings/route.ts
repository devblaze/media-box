import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { badRequest, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return ok(getDb().select().from(schema.remotePathMappings).all());
  } catch (err) {
    return serverError(err);
  }
}

const addSchema = z.object({
  downloadClientId: z.number().int(),
  remotePath: z.string().min(1),
  localPath: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const input = addSchema.parse(await request.json());
    const row = getDb().insert(schema.remotePathMappings).values(input).returning().get();
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const id = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(id)) return badRequest("Missing ?id=");
    getDb().delete(schema.remotePathMappings).where(eq(schema.remotePathMappings.id, id)).run();
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
