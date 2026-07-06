import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getRequestUser } from "@/server/auth/auth-service";
import { approveRequest } from "@/server/requests/request-service";
import { getSettings } from "@/server/settings/settings-service";
import { recordLog } from "@/server/logging/logger";
import { emitEvent } from "@/server/events/bus";
import { type RequestStage, stageFromDownload } from "@/server/requests/request-stage";
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
        // Library ids once the request has been added (used by the admin
        // interactive release search to target the movie/series).
        movieId: schema.requests.movieId,
        seriesId: schema.requests.seriesId,
      })
      .from(schema.requests)
      .innerJoin(schema.users, eq(schema.requests.userId, schema.users.id))
      .orderBy(desc(schema.requests.createdAt))
      .all();
    // regular users only see their own requests
    const visible = user.role === "admin" ? rows : rows.filter((r) => r.userId === user.id);

    // For APPROVED requests, refine the stage from the download that fulfils them.
    // Look up the newest download per fulfilled movie/series in one query; the
    // pending/declined/available states already carry their own final meaning.
    const movieIds = [
      ...new Set(
        visible.filter((r) => r.status === "approved" && r.movieId != null).map((r) => r.movieId!)
      ),
    ];
    const seriesIds = [
      ...new Set(
        visible.filter((r) => r.status === "approved" && r.seriesId != null).map((r) => r.seriesId!)
      ),
    ];
    const downloads =
      movieIds.length || seriesIds.length
        ? db
            .select({
              status: schema.downloads.status,
              statusMessage: schema.downloads.statusMessage,
              movieId: schema.downloads.movieId,
              seriesId: schema.downloads.seriesId,
            })
            .from(schema.downloads)
            .where(
              or(
                movieIds.length ? inArray(schema.downloads.movieId, movieIds) : undefined,
                seriesIds.length ? inArray(schema.downloads.seriesId, seriesIds) : undefined
              )
            )
            .orderBy(desc(schema.downloads.grabbedAt))
            .all()
        : [];
    // Rows are newest-first, so the first hit per media is the latest attempt.
    type Dl = (typeof downloads)[number];
    const byMovie = new Map<number, Dl>();
    const bySeries = new Map<number, Dl>();
    for (const d of downloads) {
      if (d.movieId != null && !byMovie.has(d.movieId)) byMovie.set(d.movieId, d);
      if (d.seriesId != null && !bySeries.has(d.seriesId)) bySeries.set(d.seriesId, d);
    }

    const withStage = visible.map((r) => {
      let stage: RequestStage;
      // declineReason for declined; a failed download's message otherwise (tooltip).
      let stageDetail: string | null = r.declineReason ?? null;
      if (r.status === "pending") stage = "pending";
      else if (r.status === "declined") stage = "declined";
      else if (r.status === "available") stage = "available";
      else {
        const dl = r.movieId != null ? byMovie.get(r.movieId) : bySeries.get(r.seriesId ?? -1);
        if (dl) {
          stage = stageFromDownload(dl.status);
          if (stage === "failed" && dl.statusMessage) stageDetail = dl.statusMessage;
        } else {
          stage = "searching";
        }
      }
      return { ...r, stage, stageDetail };
    });

    return ok(withStage);
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

    // Auto-approve mode: add straight to the library (no admin gate). If approval
    // fails (e.g. no root folder / quality profile configured yet), leave the
    // request pending so an admin can still act on it — never fail the request.
    if (getSettings().requestsAutoApprove) {
      try {
        await approveRequest(row.id, 0);
        const approved =
          db.select().from(schema.requests).where(eq(schema.requests.id, row.id)).get() ?? row;
        return ok(approved, { status: 201 });
      } catch (err) {
        recordLog("warn", `Auto-approve failed for "${row.title}"; left pending`, {
          source: "requests",
          context: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
