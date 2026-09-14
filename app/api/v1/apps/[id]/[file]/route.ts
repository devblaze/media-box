import type { NextRequest } from "next/server";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { getRequestUser } from "@/server/auth/auth-service";
import { buildPath, downloadFileName, getBuild, type AppBuild } from "@/server/apps/app-registry";
import { mintInstallToken, verifyInstallToken } from "@/server/apps/install-token";
import { resolveServerAddress } from "@/server/apps/server-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; file: string }> };

// Only these two names are ever served from a build's directory. As in the
// transcode route, the whitelist IS the path-traversal defence.
const FILE_RE = /^(download|manifest\.plist)$/;

const CONTENT_TYPES: Record<AppBuild["platform"], string> = {
  android: "application/vnd.android.package-archive",
  ios: "application/octet-stream",
};

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;"
  );
}

/**
 * The plist iOS fetches when it follows an `itms-services://` link. Everything
 * in it is escaped: the version and bundle id are admin-typed strings, and an
 * unescaped quote here turns into a plist that iOS rejects with no explanation.
 */
function manifestPlist(build: AppBuild, ipaUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${escapeXml(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${escapeXml(build.bundleId ?? "")}</string>
        <key>bundle-version</key><string>${escapeXml(build.version)}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>Media Box</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

/**
 * Serve a build, or the iOS install manifest that points at one.
 *
 * Authorised by either a normal session or a signed `?token=` — a phone
 * scanning the QR code has no account yet, which is the whole point.
 */
export async function GET(request: NextRequest, ctx: Ctx): Promise<Response> {
  const { id, file } = await ctx.params;
  if (!FILE_RE.test(file)) return new Response("Bad Request", { status: 400 });

  const token = request.nextUrl.searchParams.get("token");
  const authorised = Boolean(getRequestUser(request)) || (token && verifyInstallToken(token) === id);
  if (!authorised) return new Response("Unauthorized", { status: 401 });

  const build = getBuild(id);
  if (!build) return new Response("Not Found", { status: 404 });

  if (file === "manifest.plist") {
    const { baseUrl } = resolveServerAddress(request.headers);
    // A FRESH token, never the caller's. iOS fetches the IPA itself, in a
    // separate request that carries none of the browser's cookies, so the URL
    // inside the manifest has to stand on its own — including when an admin
    // previewed the manifest from a signed-in browser session.
    const ipaToken = mintInstallToken(build.id);
    const ipaUrl = `${baseUrl}/api/v1/apps/${build.id}/download?token=${encodeURIComponent(ipaToken)}`;
    return new Response(manifestPlist(build, ipaUrl), {
      status: 200,
      headers: {
        "Content-Type": "application/xml",
        "Cache-Control": "no-store",
      },
    });
  }

  const abs = buildPath(build);
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[build.platform],
      "Content-Length": String(size),
      // The filename is rebuilt from catalog fields, never from anything typed.
      "Content-Disposition": `attachment; filename="${downloadFileName(build)}"`,
      "Cache-Control": "no-store",
    },
  });
}
