import type { NextRequest } from "next/server";
import { z } from "zod";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { adbAvailable, installApk, isValidHost, AdbCommandError } from "@/server/apps/adb";
import { buildPath, getBuild } from "@/server/apps/app-registry";
import { ok, badRequest, notFound, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  buildId: z.string().min(1),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  // Android 11+ wireless debugging pairs on its own port with a six-digit code
  // shown on the TV. Older Android TV boxes skip this and connect straight away.
  pairPort: z.coerce.number().int().min(1).max(65535).optional(),
  pairCode: z.string().regex(/^\d{6}$/).optional(),
});

/**
 * Push a build onto a TV over the network, using adb.
 *
 * Admin-only: this reaches out to another device on the network and installs
 * software on it, which is not something a viewer account should be able to do.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }
  if (!isValidHost(body.host)) {
    return badRequest("Enter the TV's IP address or hostname on its own, with no port or scheme");
  }

  const build = getBuild(body.buildId);
  if (!build) return notFound("Build not found");
  if (build.platform !== "android") {
    return badRequest("Only Android builds can be installed over the network");
  }
  if (!(await adbAvailable())) {
    return NextResponse.json(
      {
        error:
          "adb is not available on the server, so it cannot install to a TV directly. Use the short code and on-screen steps instead.",
      },
      { status: 503 }
    );
  }

  try {
    const result = await installApk({
      host: body.host,
      port: body.port,
      apkPath: buildPath(build),
      pairPort: body.pairPort,
      pairCode: body.pairCode,
    });
    return ok({ installed: true, ...result });
  } catch (err) {
    if (err instanceof AdbCommandError) {
      // adb's own words say far more than any message this route could invent,
      // so the transcript goes back with the error for the admin to read.
      return NextResponse.json({ error: err.message, transcript: err.transcript }, { status: 502 });
    }
    return serverError(err);
  }
}
