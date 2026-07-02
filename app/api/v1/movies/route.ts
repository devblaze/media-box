import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { addMovie } from "@/server/library/movie-service";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { ok, serverError } from "@/lib/http";

export async function GET() {
  try {
    const db = getDb();
    const rows = db
      .select({
        id: schema.movies.id,
        tmdbId: schema.movies.tmdbId,
        title: schema.movies.title,
        sortTitle: schema.movies.sortTitle,
        year: schema.movies.year,
        status: schema.movies.status,
        posterPath: schema.movies.posterPath,
        path: schema.movies.path,
        monitored: schema.movies.monitored,
        qualityProfileId: schema.movies.qualityProfileId,
        movieFileId: schema.movies.movieFileId,
      })
      .from(schema.movies)
      .orderBy(asc(schema.movies.sortTitle))
      .all();
    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}

const addSchema = z.object({
  tmdbId: z.number().int().positive(),
  rootFolderId: z.number().int().positive(),
  qualityProfileId: z.number().int().positive(),
  monitored: z.boolean().optional(),
  minimumAvailability: z.enum(["announced", "inCinemas", "released"]).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const input = addSchema.parse(await request.json());
    const row = await addMovie(input);
    enqueueCommand("DiskScan", { movieId: row.id }, "system");
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
