import { NextResponse } from "next/server";
import { getBuild } from "@/server/apps/app-registry";
import { mintInstallToken, resolveShortCode } from "@/server/apps/install-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

/**
 * The short URL a TV remote can actually type, e.g. `/apk/H7K2QP`, redirecting
 * straight to the APK. Downloader-style TV apps want a URL that RETURNS the
 * file — they won't run a landing page — so this is a redirect and not a page.
 *
 * The redirect is relative on purpose: it keeps whichever host the TV reached us
 * on, which is by definition an address that works from the TV.
 */
export async function GET(_request: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  const buildId = resolveShortCode(code);
  const build = buildId ? getBuild(buildId) : undefined;
  if (!build) {
    return new NextResponse("That install code has expired. Generate a new one in Media Box.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const token = mintInstallToken(build.id);
  // A RELATIVE Location, which every HTTP client resolves against the host it
  // asked — so the redirect cannot send a TV somewhere the TV cannot reach,
  // whatever this process believes its own address to be.
  return new NextResponse(null, {
    status: 302,
    headers: { Location: `/api/v1/apps/${build.id}/download?token=${encodeURIComponent(token)}` },
  });
}
