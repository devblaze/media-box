import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getRequestUser } from "@/server/auth/auth-service";
import { requirePermissionUser } from "@/server/auth/guards";
import { approveRequest } from "@/server/requests/request-service";
import { emitEvent } from "@/server/events/bus";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

const decisionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  reason: z.string().optional(),
});

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/requests/[id]">) {
  try {
    const user = requirePermissionUser(request, "requests.approve");
    if (user instanceof NextResponse) return user;
    const { id } = await ctx.params;
    const requestId = Number(id);
    const { action, reason } = decisionSchema.parse(await request.json());

    if (action === "approve") {
      await approveRequest(requestId, user.id);
      return ok({ status: "approved" });
    }

    const db = getDb();
    const row = db.select().from(schema.requests).where(eq(schema.requests.id, requestId)).get();
    if (!row) return notFound("Request not found");
    if (row.status !== "pending") return badRequest("Request is not pending");
    db.update(schema.requests)
      .set({
        status: "declined",
        declineReason: reason ?? null,
        decidedByUserId: user.id,
        decidedAt: new Date(),
      })
      .where(eq(schema.requests.id, requestId))
      .run();
    emitEvent({ type: "request.updated", requestId });
    return ok({ status: "declined" });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/requests/[id]">) {
  try {
    const user = getRequestUser(request);
    if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { id } = await ctx.params;
    const requestId = Number(id);
    const db = getDb();
    const row = db.select().from(schema.requests).where(eq(schema.requests.id, requestId)).get();
    if (!row) return notFound("Request not found");
    if (user.role !== "admin" && row.userId !== user.id) {
      return NextResponse.json({ error: "Not your request" }, { status: 403 });
    }
    db.delete(schema.requests).where(eq(schema.requests.id, requestId)).run();
    emitEvent({ type: "request.updated", requestId });
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
