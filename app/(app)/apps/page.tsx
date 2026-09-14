"use client";

import { useState } from "react";
import { apiFetch, useApi, ApiError } from "@/lib/api";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Spinner,
} from "@/components/ui";

type Platform = "android" | "ios";

type AppBuild = {
  id: string;
  platform: Platform;
  version: string;
  sizeBytes: number;
  uploadedAt: string;
  bundleId?: string;
  notes?: string;
};

type AppsResponse = {
  builds: AppBuild[];
  address: { baseUrl: string; source: string; https: boolean; candidates: string[] };
  capabilities: { adb: boolean; ai: boolean; iosInstallable: boolean; https: boolean };
  testflightUrl: string;
};

/** What `POST /apps/link` hands back: one scannable link and its typeable twin. */
type InstallLink = {
  installUrl: string;
  shortUrl: string;
  code: string;
  expiresAt: number;
  qrSvg: string;
};

type InstallSteps = {
  steps: string[];
  source: "ai" | "builtin";
  warning?: string;
  shortUrl: string;
  code: string;
};

const MB = 1024 * 1024;

/** The newest build for a platform is the one handed out — same rule as the server's. */
function newestFor(builds: AppBuild[], platform: Platform): AppBuild | undefined {
  return [...builds]
    .filter((b) => b.platform === platform)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
}

export default function GetTheAppPage() {
  const { data, isLoading } = useApi<AppsResponse>("/apps");
  // Links are minted on demand rather than with the page, because each one
  // starts a clock and most visits only ever want one of them.
  const [links, setLinks] = useState<Record<string, InstallLink>>({});
  const [minting, setMinting] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function showLink(buildId: string) {
    setMinting(buildId);
    setLinkError(null);
    try {
      const link = await apiFetch<InstallLink>("/apps/link", {
        method: "POST",
        body: JSON.stringify({ buildId }),
      });
      setLinks((prev) => ({ ...prev, [buildId]: link }));
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : "Could not create an install link.");
    } finally {
      setMinting(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  }

  const builds = data?.builds ?? [];
  const android = newestFor(builds, "android");
  const ios = newestFor(builds, "ios");
  const address = data?.address;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-white">Get the app</h1>
        <p className="text-sm text-zinc-400">
          Install Media Box straight from this server. Nothing goes through an app store.
        </p>
      </header>

      {builds.length === 0 && (
        <EmptyState
          title="No app builds yet"
          description="An administrator needs to upload a build under Settings, App Installs before anything can be installed from here."
        />
      )}

      {address && builds.length > 0 && (
        <p className="text-xs text-zinc-500">
          Codes point at <span className="font-mono text-zinc-400">{address.baseUrl}</span>. Your
          phone has to be on the same network as this server for that address to work.
        </p>
      )}

      {linkError && <Callout tone="danger">{linkError}</Callout>}

      {android && (
        <PhoneCard
          title="Android phone or tablet"
          build={android}
          link={links[android.id]}
          busy={minting === android.id}
          onShow={() => showLink(android.id)}
          steps={[
            "Scan the code with your camera and open the link.",
            "Tap Download, then open the downloaded file.",
            "Android will ask permission to install from your browser. Allow it, then open the file again and tap Install.",
          ]}
        />
      )}

      {ios && (
        <PhoneCard
          title="iPhone or iPad"
          build={ios}
          link={links[ios.id]}
          busy={minting === ios.id}
          onShow={() => showLink(ios.id)}
          steps={[
            "Scan the code with your camera and open the link.",
            "Tap Install and confirm. The icon appears on your home screen.",
            "If the app will not open, trust the developer under Settings, General, VPN & Device Management.",
          ]}
          warning={
            data && !data.capabilities.https
              ? "iOS will refuse this install: Apple requires the install link to come over HTTPS with a valid certificate, and this server is being reached over plain HTTP."
              : undefined
          }
        />
      )}

      {android && <TvCard build={android} aiAvailable={data?.capabilities.ai ?? false} />}

      <AppleTvCard testflightUrl={data?.testflightUrl ?? ""} />
    </div>
  );
}

/** A phone platform: the QR code, what it points at, and what to do after scanning. */
function PhoneCard({
  title,
  build,
  link,
  busy,
  onShow,
  steps,
  warning,
}: {
  title: string;
  build: AppBuild;
  link?: InstallLink;
  busy: boolean;
  onShow: () => void;
  steps: string[];
  warning?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <Badge>
          {build.version} · {(build.sizeBytes / MB).toFixed(1)} MB
        </Badge>
      </CardHeader>
      <CardBody className="space-y-4">
        {warning && <Callout tone="warning">{warning}</Callout>}
        {!link ? (
          <Button onClick={onShow} loading={busy}>
            Show QR code
          </Button>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {/* Our own generated SVG, not anything a user supplied. */}
            <div
              className="size-44 shrink-0 rounded-lg bg-white p-2"
              dangerouslySetInnerHTML={{ __html: link.qrSvg }}
            />
            <div className="min-w-0 space-y-3">
              <ol className="space-y-1 text-sm text-zinc-400">
                {steps.map((step, i) => (
                  <li key={step}>
                    {i + 1}. {step}
                  </li>
                ))}
              </ol>
              <p className="text-xs text-zinc-500">
                Or open this link on the phone:{" "}
                <span className="font-mono break-all text-zinc-400">{link.installUrl}</span>
              </p>
              <p className="text-xs text-zinc-500">
                The code stops working half an hour after it is created.{" "}
                <button type="button" onClick={onShow} className="underline hover:text-zinc-300">
                  Make a new one
                </button>
              </p>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * TVs have no camera, so a QR code is no use to them. What works is a short URL
 * typed into a downloader app with a remote, and steps for the specific box —
 * the menu path differs enough between a Fire TV and a Google TV to matter.
 */
function TvCard({ build, aiAvailable }: { build: AppBuild; aiAvailable: boolean }) {
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [result, setResult] = useState<InstallSteps | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function getSteps() {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await apiFetch<InstallSteps>("/apps/tv/instructions", {
          method: "POST",
          body: JSON.stringify({ buildId: build.id, brand, model }),
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not work out the steps.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Android TV, Google TV or Fire TV</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-sm text-zinc-400">
          Tell us what the TV is and you will get the steps for that box, along with a short
          address to type into it.
        </p>
        <Callout tone="warning" title="This is the phone build">
          There is no separate TV build yet. This one installs on a TV but will not appear on the
          TV home screen, and it expects a touchscreen rather than a remote. Reach it through the
          device&apos;s app list in the meantime.
        </Callout>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Make" htmlFor="tv-brand" description="Sony, Amazon, Nvidia, Philips…">
            <Input
              id="tv-brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Amazon"
            />
          </Field>
          <Field label="Model" htmlFor="tv-model" description="Optional, but it sharpens the steps.">
            <Input
              id="tv-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Fire TV Stick 4K"
            />
          </Field>
        </div>
        <Button onClick={getSteps} loading={busy}>
          Show me the steps
        </Button>
        {!aiAvailable && (
          <p className="text-xs text-zinc-500">
            No AI provider is configured, so these will be the general steps rather than ones
            written for your exact model. An administrator can connect one under Settings, General.
          </p>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
        {result && (
          <div className="space-y-3 rounded-lg border border-white/10 bg-black/30 p-4">
            <p className="text-sm text-zinc-300">
              Type this into the TV:{" "}
              <span className="font-mono text-amber-300">{result.shortUrl}</span>
            </p>
            {result.warning && <Callout tone="warning">{result.warning}</Callout>}
            <ol className="space-y-1 text-sm text-zinc-400">
              {result.steps.map((step, i) => (
                <li key={step}>
                  {i + 1}. {step}
                </li>
              ))}
            </ol>
            <p className="text-xs text-zinc-500">
              {result.source === "ai"
                ? "Written for this device by your AI provider — check the menu names against what you see."
                : "General steps, which cover most devices."}{" "}
              The address stops working after half an hour.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Apple TV has no sideloading path of any kind, so the honest answer is what
 *  else will work rather than a button that cannot. */
function AppleTvCard({ testflightUrl }: { testflightUrl: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Apple TV</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-zinc-400">
          Apple does not allow apps to be installed on an Apple TV from anywhere but the App Store
          or TestFlight, so this server cannot hand one over. There is no setting that changes this.
        </p>
        <p className="text-sm text-zinc-400">
          What does work today: install the iPhone app and use AirPlay to send what you are watching
          to the Apple TV.
        </p>
        {testflightUrl && (
          <a
            href={testflightUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-sm text-amber-400 underline"
          >
            Join the TestFlight beta
          </a>
        )}
      </CardBody>
    </Card>
  );
}
