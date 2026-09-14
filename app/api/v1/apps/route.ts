import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin, requireUser } from "@/server/auth/guards";
import { aiEnabled } from "@/server/ai/llm";
import { adbAvailable } from "@/server/apps/adb";
import {
  BuildTooLargeError,
  listBuilds,
  latestBuild,
  saveBuild,
  MAX_BUILD_BYTES,
} from "@/server/apps/app-registry";
import { resolveServerAddress } from "@/server/apps/server-address";
import { getSettings } from "@/server/settings/settings-service";
import { ok, badRequest, serverError } from "@/lib/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The builds this server hands out, plus everything the "Get the app" page needs
 * to explain itself: the address a phone should use, and which install routes
 * are actually open on this deployment.
 */
export async function GET(request: NextRequest) {
  const denied = requireUser(request);
  if (denied) return denied;

  try {
    const address = resolveServerAddress(request.headers);
    const ios = latestBuild("ios");
    return ok({
      builds: listBuilds(),
      address,
      capabilities: {
        // Whether the server can push an APK to a TV itself.
        adb: await adbAvailable(),
        ai: aiEnabled(),
        // Three things have to hold before an iPhone can install: a build, a
        // bundle id for the manifest to name, and HTTPS with a certificate the
        // device already trusts. The install page checks the same three.
        iosInstallable: Boolean(ios?.bundleId) && address.https,
        https: address.https,
      },
      testflightUrl: getSettings().appTestflightUrl,
      maxBuildBytes: MAX_BUILD_BYTES,
    });
  } catch (err) {
    return serverError(err);
  }
}

const uploadSchema = z.object({
  platform: z.enum(["android", "ios"]),
  version: z.string().min(1).max(64),
  // Required for iOS: the manifest must name the IPA's real bundle id.
  bundleId: z.string().max(255).optional(),
  notes: z.string().max(500).optional(),
});

/**
 * Upload a build. The metadata rides in the query string and the binary IS the
 * body — an APK is tens of megabytes, and multipart would mean buffering the
 * whole thing in memory to parse one field out of it.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = uploadSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest("Invalid upload metadata");
  if (parsed.data.platform === "ios" && !parsed.data.bundleId) {
    return badRequest("An iOS build needs its bundle identifier — the install manifest carries it");
  }
  if (!request.body) return badRequest("Missing request body");

  try {
    const build = await saveBuild(parsed.data, request.body);
    return ok(build, { status: 201 });
  } catch (err) {
    if (err instanceof BuildTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    return serverError(err);
  }
}
