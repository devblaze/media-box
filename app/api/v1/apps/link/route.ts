import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/guards";
import { getBuild } from "@/server/apps/app-registry";
import { mintInstallToken, mintShortCode, INSTALL_TOKEN_TTL_MS } from "@/server/apps/install-token";
import { qrSvg } from "@/server/apps/qr";
import { resolveServerAddress } from "@/server/apps/server-address";
import { ok, badRequest, notFound, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ buildId: z.string().min(1) });

/**
 * Mint everything needed to get one build onto one device: a scannable link, the
 * QR code for it, and a short code for a TV that has a remote instead of a
 * camera. All three expire together.
 *
 * The QR points at the install PAGE rather than at the binary, because iOS can
 * only start an install from a link tapped in Safari, and because the page can
 * tell an iPhone from an Android before deciding what to offer.
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
    const installUrl = `${address.baseUrl}/get/${token}`;
    return ok({
      buildId: build.id,
      installUrl,
      downloadUrl: `${address.baseUrl}/api/v1/apps/${build.id}/download?token=${encodeURIComponent(token)}`,
      // Short enough to type on a TV remote, into an app like Downloader.
      shortUrl: `${address.baseUrl}/apk/${code}`,
      code,
      expiresAt,
      ttlMs: INSTALL_TOKEN_TTL_MS,
      qrSvg: await qrSvg(installUrl),
      address,
    });
  } catch (err) {
    return serverError(err);
  }
}
