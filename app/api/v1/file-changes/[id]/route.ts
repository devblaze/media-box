import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { requirePermissionUser } from "@/server/auth/guards";
import {
  approveFileChange,
  declineFileChange,
} from "@/server/library/file-change-service";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

const decisionSchema = z.object({
  action: z.enum(["approve", "decline"]),
});

/**
 * Approve or decline a held file change. Approving performs the real file
 * operation (import / organize / delete); declining releases it. Requires the
 * `files.approve` permission (admins always).
 */
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/file-changes/[id]">) {
  try {
    const user = requirePermissionUser(request, "files.approve");
    if (user instanceof NextResponse) return user;
    const { id } = await ctx.params;
    const changeId = Number(id);
    const { action } = decisionSchema.parse(await request.json());

    // A decision only applies to a pending change; validating up front turns a
    // double-click / stale action into a clean 404/400 instead of a 500.
    const db = getDb();
    const row = db
      .select()
      .from(schema.fileChanges)
      .where(eq(schema.fileChanges.id, changeId))
      .get();
    if (!row) return notFound("File change not found");
    if (row.status !== "pending") return badRequest("File change is not pending");

    if (action === "approve") {
      const result = await approveFileChange(changeId, user.id);
      return ok(result);
    }

    declineFileChange(changeId, user.id);
    return ok({ status: "declined" });
  } catch (err) {
    return serverError(err);
  }
}
