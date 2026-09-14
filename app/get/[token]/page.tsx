import { headers } from "next/headers";
import { getBuild } from "@/server/apps/app-registry";
import { verifyInstallToken } from "@/server/apps/install-token";
import { resolveServerAddress } from "@/server/apps/server-address";

export const dynamic = "force-dynamic";

/**
 * Where a scanned QR code lands. Deliberately public and account-free: the
 * person holding the phone is trying to GET the app, so requiring them to sign
 * in first would be a circular door. The signed token in the URL is the
 * credential, and it names exactly one build for a limited time.
 */
export default async function InstallPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const buildId = verifyInstallToken(token);
  const build = buildId ? getBuild(buildId) : undefined;
  const head = await headers();
  const address = resolveServerAddress(head);
  const userAgent = head.get("user-agent") ?? "";
  const isApple = /iPhone|iPad|iPod/i.test(userAgent);

  if (!build) {
    return (
      <Shell title="This install link has expired">
        <p className="text-sm text-zinc-400">
          Install links are good for half an hour. Open Media Box on your computer, go to Get the
          app, and scan the new code.
        </p>
      </Shell>
    );
  }

  const downloadUrl = `/api/v1/apps/${build.id}/download?token=${encodeURIComponent(token)}`;
  const manifestUrl = `${address.baseUrl}/api/v1/apps/${build.id}/manifest.plist?token=${encodeURIComponent(token)}`;
  const megabytes = (build.sizeBytes / 1024 / 1024).toFixed(1);

  // iOS will only install from a manifest served over HTTPS with a certificate
  // the device already trusts. Over plain http the link silently does nothing,
  // so say why instead of offering a button that cannot work.
  const appleInstallable = build.platform === "ios" && address.https && Boolean(build.bundleId);

  return (
    <Shell title="Install Media Box">
      <p className="text-sm text-zinc-400">
        Version {build.version} · {megabytes} MB · {build.platform === "ios" ? "iPhone" : "Android"}
      </p>

      {build.platform === "android" && (
        <>
          <a
            href={downloadUrl}
            className="mt-6 block rounded-lg bg-amber-500 px-4 py-3 text-center text-sm font-semibold text-black"
          >
            Download the app
          </a>
          <ol className="mt-6 space-y-2 text-sm text-zinc-400">
            <li>1. Tap Download above and wait for it to finish.</li>
            <li>2. Open the downloaded file. Android will ask permission to install from this
              browser — allow it, then come back and open the file again.</li>
            <li>3. Tap Install, then Open.</li>
          </ol>
        </>
      )}

      {build.platform === "ios" && appleInstallable && (
        <>
          <a
            href={`itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`}
            className="mt-6 block rounded-lg bg-amber-500 px-4 py-3 text-center text-sm font-semibold text-black"
          >
            Install
          </a>
          <ol className="mt-6 space-y-2 text-sm text-zinc-400">
            <li>1. Tap Install, then confirm when iOS asks.</li>
            <li>2. The icon appears on your home screen with a progress ring.</li>
            <li>3. The first launch may need Settings, General, VPN &amp; Device Management, where
              you trust the developer.</li>
          </ol>
        </>
      )}

      {build.platform === "ios" && !appleInstallable && (
        <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          {!address.https
            ? "iPhone installs have to come over HTTPS with a valid certificate. This server is being reached over plain HTTP, so iOS will refuse the install."
            : "This build has no bundle identifier recorded, so the install manifest cannot be built."}
        </div>
      )}

      {isApple && build.platform === "android" && (
        <p className="mt-6 text-sm text-zinc-500">
          This is the Android build. Ask whoever runs the server for the iPhone one.
        </p>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900/60 p-6">
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        {children}
      </div>
    </main>
  );
}
