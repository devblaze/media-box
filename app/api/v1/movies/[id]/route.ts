import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { deleteMovie } from "@/server/library/movie-service";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { emitEvent } from "@/server/events/bus";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/v1/movies/[id]">) {
  try {
    const { id } = await ctx.params;
    const movieId = Number(id);
    const db = getDb();
    const row = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
    if (!row) return notFound("Movie not found");
    const file = row.movieFileId
      ? db.select().from(schema.movieFiles).where(eq(schema.movieFiles.id, row.movieFileId)).get()
      : null;
    return ok({ ...row, file });
  } catch (err) {
    return serverError(err);
  }
}

const patchSchema = z.object({
  monitored: z.boolean().optional(),
  qualityProfileId: z.number().int().positive().optional(),
  minimumAvailability: z.enum(["announced", "inCinemas", "released"]).optional(),
});

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/movies/[id]">) {
  try {
    const { id } = await ctx.params;
    const movieId = Number(id);
    const db = getDb();
    const existing = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
    if (!existing) return notFound("Movie not found");
    const patch = patchSchema.parse(await request.json());
    db.update(schema.movies).set(patch).where(eq(schema.movies.id, movieId)).run();
    emitEvent({ type: "movie.updated", movieId });
    return ok(db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get());
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/movies/[id]">) {
  try {
    const { id } = await ctx.params;
    const movieId = Number(id);
    if (!Number.isInteger(movieId)) return badRequest("Invalid id");
    const deleteFiles = request.nextUrl.searchParams.get("deleteFiles") === "true";
    const res = await deleteMovie(movieId, deleteFiles);
    // Ask mode: a with-files delete is held for approval rather than performed now.
    if (res && "held" in res) return ok({ held: true, id: res.id });
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
