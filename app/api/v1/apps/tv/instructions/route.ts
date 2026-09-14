import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/guards";
import { getBuild } from "@/server/apps/app-registry";
import { mintInstallToken, mintShortCode } from "@/server/apps/install-token";
import { resolveServerAddress } from "@/server/apps/server-address";
import { deviceSteps } from "@/server/apps/tv-instructions";
import { ok, badRequest, notFound, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  buildId: z.string().min(1),
  brand: z.string().max(60).optional(),
  model: z.string().max(60).optional(),
  os: z.string().max(60).optional(),
});

/**
 * Steps for installing a build on one particular TV by hand, written by the
 * configured AI provider when there is one and falling back to built-in generic
 * steps when there isn't. The menu path differs enough between a Fire TV, a
 * Google TV and a six-year-old Sony that generic steps alone leave people stuck.
 */
export async function POST(request: NextRequest) {
  const denied = requireUser(request);
  if (denied) return denied;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  const build = getBuild(body.buildId);
  if (!build) return notFound("Build not found");

  try {
    const address = resolveServerAddress(request.headers);
    const token = mintInstallToken(build.id);
    const { code, expiresAt } = mintShortCode(build.id);
    const shortUrl = `${address.baseUrl}/apk/${code}`;
    const downloadUrl = `${address.baseUrl}/api/v1/apps/${build.id}/download?token=${encodeURIComponent(token)}`;
    const result = await deviceSteps(
      { brand: body.brand, model: body.model, os: body.os },
      downloadUrl,
      shortUrl
    );
    return ok({ ...result, shortUrl, code, expiresAt });
  } catch (err) {
    return serverError(err);
  }
}
