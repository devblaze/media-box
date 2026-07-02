import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getRequestUser } from "@/server/auth/auth-service";
import { emitEvent } from "@/server/events/bus";
import { ok, serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const user = getRequestUser(request);
    if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const db = getDb();
    const rows = db
      .select({
        id: schema.requests.id,
        mediaType: schema.requests.mediaType,
        tmdbId: schema.requests.tmdbId,
        title: schema.requests.title,
        year: schema.requests.year,
        posterPath: schema.requests.posterPath,
        seasons: schema.requests.seasons,
        status: schema.requests.status,
        declineReason: schema.requests.declineReason,
        createdAt: schema.requests.createdAt,
        userId: schema.requests.userId,
        username: schema.users.username,
      })
      .from(schema.requests)
      .innerJoin(schema.users, eq(schema.requests.userId, schema.users.id))
      .orderBy(desc(schema.requests.createdAt))
      .all();
    // regular users only see their own requests
    return ok(user.role === "admin" ? rows : rows.filter((r) => r.userId === user.id));
  } catch (err) {
    return serverError(err);
  }
}

const addSchema = z.object({
  mediaType: z.enum(["series", "movie"]),
  tmdbId: z.number().int().positive(),
  title: z.string().min(1),
  year: z.number().int().nullable().optional(),
  posterPath: z.string().nullable().optional(),
  seasons: z.array(z.number().int()).nullable().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = getRequestUser(request);
    if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (user.id === 0) return NextResponse.json({ error: "Use a real user account" }, { status: 400 });
    const input = addSchema.parse(await request.json());

    const db = getDb();
    const duplicate = db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.tmdbId, input.tmdbId),
          eq(schema.requests.mediaType, input.mediaType),
          eq(schema.requests.userId, user.id)
        )
      )
      .get();
    if (duplicate) return NextResponse.json({ error: "Already requested" }, { status: 409 });

    const row = db
      .insert(schema.requests)
      .values({
        userId: user.id,
        mediaType: input.mediaType,
        tmdbId: input.tmdbId,
        title: input.title,
        year: input.year ?? null,
        posterPath: input.posterPath ?? null,
        seasons: input.seasons ?? null,
        status: "pending",
        createdAt: new Date(),
      })
      .returning()
      .get();
    emitEvent({ type: "request.updated", requestId: row.id });
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
