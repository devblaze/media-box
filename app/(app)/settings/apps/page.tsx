"use client";

import { useRef, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
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
  HowTo,
  Input,
  Select,
  Skeleton,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Textarea,
  useConfirm,
  useToast,
} from "@/components/ui";

type AppPlatform = "android" | "ios";

/** Mirrors `AppBuild` in server/apps/app-registry.ts. */
interface AppBuild {
  id: string;
  platform: AppPlatform;
  version: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  bundleId?: string;
  notes?: string;
}

/** Mirrors `ServerAddress` in server/apps/server-address.ts. */
interface ServerAddress {
  baseUrl: string;
  source: "setting" | "request" | "interface" | "fallback";
  https: boolean;
  candidates: string[];
}

interface AppsResponse {
  builds: AppBuild[];
  address: ServerAddress;
  capabilities: { adb: boolean; ai: boolean; iosInstallable: boolean; https: boolean };
  testflightUrl: string;
  maxBuildBytes: number;
}

/** Subset of app settings this page reads. */
interface AppSettings {
  appDownloadBaseUrl?: string;
  appTestflightUrl?: string;
}

const PLATFORM_LABEL: Record<AppPlatform, string> = { android: "Android", ios: "iOS" };
const PLATFORM_EXTENSION: Record<AppPlatform, string> = { android: ".apk", ios: ".ipa" };

/** Plain-words account of how the server settled on the address it hands out. */
const ADDRESS_SOURCE: Record<ServerAddress["source"], string> = {
  request: "the address you are browsing on, which is what a phone on this network should use",
  setting: "set below",
  interface: "this server's own network address, because you are browsing on localhost",
  fallback: "could not be determined",
};

/** Build sizes are only ever eyeballed, so one decimal of MB is plenty. */
function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * Raw XHR rather than `apiFetch`: the body is the build file itself (the route
 * takes its metadata from the query string), which rules out apiFetch's forced
 * JSON content type, and XHR is the only way to watch a multi-megabyte upload
 * actually progress instead of showing a spinner for a minute.
 */
function uploadBuild(
  url: string,
  file: File,
  onProgress: (percent: number) => void
): Promise<AppBuild> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let body: { error?: string } | AppBuild | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error body (a proxy page, say) — fall back to the status.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as AppBuild);
      } else {
        const message = (body as { error?: string } | null)?.error;
        reject(new Error(message ?? `Upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed — the connection dropped")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(file);
  });
}

export default function AppInstallsSettingsPage() {
  const { data, mutate, isLoading } = useApi<AppsResponse>("/apps");
  const { data: settings, mutate: mutateSettings } = useApi<AppSettings>("/settings");
  const toast = useToast();
  const confirm = useConfirm();

  // Upload form.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<AppPlatform>("android");
  const [version, setVersion] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [notes, setNotes] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Settings fields. They arrive after the first paint, so the typed draft sits
  // on top of the fetched value: seeding state from an effect instead would
  // overwrite what is being typed every time SWR revalidates.
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [testflightDraft, setTestflightDraft] = useState<string | null>(null);
  const baseUrlValue = baseUrlDraft ?? settings?.appDownloadBaseUrl ?? "";
  const testflightValue = testflightDraft ?? settings?.appTestflightUrl ?? "";
  const [savingBaseUrl, setSavingBaseUrl] = useState(false);
  const [savingTestflight, setSavingTestflight] = useState(false);

  // TV install form.
  const [tvBuildId, setTvBuildId] = useState("");
  const [tvHost, setTvHost] = useState("");
  const [tvPort, setTvPort] = useState("");
  const [tvPairPort, setTvPairPort] = useState("");
  const [tvPairCode, setTvPairCode] = useState("");
  const [installing, setInstalling] = useState(false);
  const [transcript, setTranscript] = useState<{ ok: boolean; text: string } | null>(null);

  const builds = data?.builds ?? [];
  const androidBuilds = builds.filter((b) => b.platform === "android");
  const maxBuildBytes = data?.maxBuildBytes ?? 0;
  const adbAvailable = data?.capabilities.adb ?? false;

  // Which rows are live: the server always hands out the newest upload per
  // platform, and the list is newest-first.
  const servedIds = new Set(
    (["android", "ios"] as AppPlatform[])
      .map((p) => builds.find((b) => b.platform === p)?.id)
      .filter((id): id is string => Boolean(id))
  );

  // Falling back to the first Android build keeps the selector meaningful
  // without an effect that picks a default after the list loads.
  const tvBuild = androidBuilds.find((b) => b.id === tvBuildId) ?? androidBuilds[0];

  // The install route accepts exactly six digits and answers anything else with
  // a bare "Invalid request body", so catch it here where it can be explained.
  const tvPairCodeInvalid = tvPairCode.trim() !== "" && !/^\d{6}$/.test(tvPairCode.trim());

  /** First thing wrong with the upload form, or null when it is ready to send. */
  function uploadProblem(): string | null {
    if (!file) return "Choose a build file.";
    const extension = PLATFORM_EXTENSION[platform];
    if (!file.name.toLowerCase().endsWith(extension)) {
      return `A ${PLATFORM_LABEL[platform]} build has to be a ${extension} file. ${file.name} is not one — check the platform above.`;
    }
    if (maxBuildBytes > 0 && file.size > maxBuildBytes) {
      return `That file is ${megabytes(file.size)} MB and the limit is ${megabytes(maxBuildBytes)} MB.`;
    }
    if (!version.trim()) return "Give the build a version, for example 1.0.0.";
    if (platform === "ios" && !bundleId.trim()) {
      return "An iOS build needs its bundle identifier.";
    }
    return null;
  }
  const problem = uploadProblem();

  async function upload() {
    if (!file || problem) return;
    setUploading(true);
    setProgress(0);
    try {
      const params = new URLSearchParams({ platform, version: version.trim() });
      if (platform === "ios") params.set("bundleId", bundleId.trim());
      if (notes.trim()) params.set("notes", notes.trim());

      const build = await uploadBuild(`/api/v1/apps?${params.toString()}`, file, setProgress);
      await mutate();
      setFile(null);
      setVersion("");
      setBundleId("");
      setNotes("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast.success(`${PLATFORM_LABEL[build.platform]} ${build.version} uploaded`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove(build: AppBuild) {
    const confirmed = await confirm({
      title: "Delete build",
      message: `Delete the ${PLATFORM_LABEL[build.platform]} build ${build.version}? Devices that already installed it keep it, but nobody can download it again.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    setDeletingId(build.id);
    try {
      await apiFetch(`/apps/${build.id}`, { method: "DELETE" });
      await mutate();
      toast.success("Build deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function saveBaseUrl() {
    setSavingBaseUrl(true);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({ appDownloadBaseUrl: baseUrlValue.trim() }),
      });
      setBaseUrlDraft(null);
      await mutateSettings();
      // The address the server hands out is derived from this setting, so the
      // card above is stale until /apps is fetched again.
      await mutate();
      toast.success("Distribution address saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSavingBaseUrl(false);
    }
  }

  async function saveTestflight() {
    setSavingTestflight(true);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({ appTestflightUrl: testflightValue.trim() }),
      });
      setTestflightDraft(null);
      await mutateSettings();
      await mutate();
      toast.success("TestFlight link saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSavingTestflight(false);
    }
  }

  async function installToTv() {
    if (!tvBuild) return;
    setInstalling(true);
    setTranscript(null);
    try {
      const result = await apiFetch<{ installed: boolean; transcript: string; serial: string }>(
        "/apps/tv/install",
        {
          method: "POST",
          body: JSON.stringify({
            buildId: tvBuild.id,
            host: tvHost.trim(),
            ...(tvPort.trim() ? { port: Number(tvPort) } : {}),
            ...(tvPairPort.trim() ? { pairPort: Number(tvPairPort) } : {}),
            ...(tvPairCode.trim() ? { pairCode: tvPairCode.trim() } : {}),
          }),
        }
      );
      setTranscript({ ok: true, text: result.transcript });
      toast.success(`Installed on ${result.serial}`);
    } catch (err) {
      // A failed install answers with adb's own output, which says far more
      // than any summary — show it where the successful transcript goes.
      const message = err instanceof Error ? err.message : "Install failed";
      setTranscript({ ok: false, text: message });
      toast.error("Install failed");
    } finally {
      setInstalling(false);
    }
  }

  const address = data?.address;
  const addressNeedsAttention =
    address !== undefined &&
    (address.source === "interface" ||
      address.source === "fallback" ||
      address.candidates.length > 1);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">App Installs</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Host the media-box app builds here so people install from this server instead of an app
          store.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Builds</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-zinc-400">
            The newest upload per platform is the one handed out. Older builds stay listed so you can
            delete a bad one and fall back.
          </p>

          {isLoading ? (
            <Skeleton className="h-28 w-full rounded-lg" />
          ) : builds.length === 0 ? (
            <EmptyState
              title="No builds uploaded"
              description="Nothing is being handed out yet. Upload an APK or IPA below and it becomes the build this server offers."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Platform</TH>
                  <TH>Version</TH>
                  <TH>Size</TH>
                  <TH>Uploaded</TH>
                  <TH>SHA-256</TH>
                  <TH>Notes</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {builds.map((build) => (
                  <TR key={build.id}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <Badge tone={build.platform === "android" ? "success" : "info"}>
                          {PLATFORM_LABEL[build.platform]}
                        </Badge>
                        {servedIds.has(build.id) && <Badge tone="accent">Handed out</Badge>}
                      </div>
                    </TD>
                    <TD className="font-mono">{build.version}</TD>
                    <TD className="whitespace-nowrap">{megabytes(build.sizeBytes)} MB</TD>
                    <TD className="whitespace-nowrap">
                      {new Date(build.uploadedAt).toLocaleDateString()}
                    </TD>
                    <TD className="font-mono text-xs text-zinc-500" title={build.sha256}>
                      {build.sha256.slice(0, 12)}
                    </TD>
                    <TD className="max-w-48 truncate text-zinc-400" title={build.notes}>
                      {build.notes ?? "—"}
                    </TD>
                    <TD className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-300"
                        onClick={() => remove(build)}
                        loading={deletingId === build.id}
                        disabled={deletingId === build.id}
                      >
                        Delete
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upload a build</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Platform" htmlFor="build-platform">
            <Select
              id="build-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as AppPlatform)}
              disabled={uploading}
            >
              <option value="android">Android (.apk)</option>
              <option value="ios">iOS (.ipa)</option>
            </Select>
          </Field>

          <Field
            label="Build file"
            htmlFor="build-file"
            description={
              maxBuildBytes > 0
                ? `${PLATFORM_EXTENSION[platform]} file, up to ${megabytes(maxBuildBytes)} MB.`
                : undefined
            }
          >
            <input
              id="build-file"
              ref={fileInputRef}
              type="file"
              accept={PLATFORM_EXTENSION[platform]}
              disabled={uploading}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full cursor-pointer rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-zinc-800 file:px-3 file:py-1 file:text-xs file:text-zinc-200 hover:file:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </Field>

          <Field label="Version" htmlFor="build-version" required>
            <Input
              id="build-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="font-mono"
              placeholder="1.0.0"
              disabled={uploading}
            />
          </Field>

          {platform === "ios" && (
            <Field
              label="Bundle identifier"
              htmlFor="build-bundle-id"
              required
              description="The iOS install manifest has to carry the IPA's real bundle id, or the install fails on the device with no useful error."
            >
              <Input
                id="build-bundle-id"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                className="font-mono"
                placeholder="org.example.mediabox"
                disabled={uploading}
              />
            </Field>
          )}

          <Field
            label="Notes (optional)"
            htmlFor="build-notes"
            description="Anything the next admin needs to know, such as which devices an ad-hoc build covers."
          >
            <Textarea
              id="build-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={uploading}
            />
          </Field>

          {file && problem && <p className="text-xs text-red-400">{problem}</p>}

          {uploading && (
            <div className="space-y-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-amber-500 transition-[width] duration-150"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-zinc-500">
                Uploading — {progress}%
                {file ? ` of ${megabytes(file.size)} MB` : ""}
              </p>
            </div>
          )}

          <Button onClick={upload} loading={uploading} disabled={uploading || problem !== null}>
            {uploading ? "Uploading…" : "Upload build"}
          </Button>

          <div className="space-y-3 border-t border-zinc-800 pt-4">
            <Callout tone="info" title="Apple devices">
              <p>
                Apple does not allow self-hosted iPhone installs without a paid Apple Developer
                account, and even with one the phone only accepts an install when this server is
                reachable over HTTPS with a valid certificate. Apple TV has no sideloading path at
                all.
              </p>
            </Callout>

            <Field
              label="TestFlight link"
              htmlFor="app-testflight-url"
              description="The fallback for Apple users: where the Get the app page sends them when a self-hosted install is not possible."
            >
              <Input
                id="app-testflight-url"
                value={testflightValue}
                onChange={(e) => setTestflightDraft(e.target.value)}
                className="font-mono"
                placeholder="https://testflight.apple.com/join/..."
              />
            </Field>
            <Button
              variant="secondary"
              size="sm"
              onClick={saveTestflight}
              loading={savingTestflight}
              disabled={savingTestflight || !settings}
            >
              {savingTestflight ? "Saving…" : "Save TestFlight link"}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Distribution address</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-zinc-400">
            Download links and QR codes on the Get the app page point at this address. A device only
            reaches the app if the address works from that device.
          </p>

          {address ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-sm text-zinc-100">{address.baseUrl}</span>
                <Badge tone={address.https ? "success" : "neutral"}>
                  {address.https ? "HTTPS" : "HTTP"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Where this came from: {ADDRESS_SOURCE[address.source]}.
              </p>
            </div>
          ) : (
            <Skeleton className="h-16 w-full rounded-lg" />
          )}

          {address && addressNeedsAttention && (
            <Callout tone="warning" title="Check this address before sharing a QR code">
              <p>
                A QR code pointing at an address a phone cannot reach simply fails, with nothing to
                explain why. This server can see
                {address.candidates.length === 1 ? " this address" : " these addresses"}:
              </p>
              <ul className="mt-1 space-y-0.5">
                {address.candidates.map((candidate) => (
                  <li key={candidate}>
                    <code>{candidate}</code>
                  </li>
                ))}
              </ul>
              {address.candidates.length === 0 && (
                <p className="mt-1">No network address could be detected at all.</p>
              )}
              <p className="mt-1">
                If the one above is not the one a phone on your network would use, set the correct
                one in the override below.
              </p>
            </Callout>
          )}

          <Field
            label="Address override"
            htmlFor="app-download-base-url"
            description="Leave blank to use the address you are browsing on, which is usually right. Set it when the server cannot work out its own reachable address."
          >
            <Input
              id="app-download-base-url"
              value={baseUrlValue}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              className="font-mono"
              placeholder="http://192.168.1.10:7878"
            />
          </Field>

          <p className="text-xs text-zinc-500">
            Inside Docker on the default bridge network, the address the server detects for itself is
            the container&apos;s (a 172.x address), which no phone can reach. Setting the override to
            the host&apos;s LAN address is the fix there.
          </p>

          <Button
            onClick={saveBaseUrl}
            loading={savingBaseUrl}
            disabled={savingBaseUrl || !settings}
          >
            {savingBaseUrl ? "Saving…" : "Save address"}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Install to a TV over the network</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-zinc-400">
            Push an Android build straight onto an Android TV that has network debugging switched on.
            Only Android builds can be installed this way.
          </p>

          {!isLoading && !adbAvailable && (
            <Callout tone="warning" title="This server has no adb binary">
              <p>
                Installing over the network needs the <code>adb</code> tool on the server, and it is
                not installed here. The Get the app page offers a typeable short code instead, which
                the TV owner enters on the TV.
              </p>
            </Callout>
          )}

          {androidBuilds.length === 0 ? (
            <EmptyState
              title="No Android build to install"
              description="Upload an APK above, then come back to push it to a TV."
            />
          ) : (
            <>
              <Field label="Build" htmlFor="tv-build">
                <Select
                  id="tv-build"
                  value={tvBuild?.id ?? ""}
                  onChange={(e) => setTvBuildId(e.target.value)}
                  disabled={!adbAvailable || installing}
                >
                  {androidBuilds.map((build) => (
                    <option key={build.id} value={build.id}>
                      {build.version} — {megabytes(build.sizeBytes)} MB,{" "}
                      {new Date(build.uploadedAt).toLocaleDateString()}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="TV IP address" htmlFor="tv-host" required>
                  <Input
                    id="tv-host"
                    value={tvHost}
                    onChange={(e) => setTvHost(e.target.value)}
                    className="font-mono"
                    placeholder="192.168.1.42"
                    disabled={!adbAvailable || installing}
                  />
                </Field>
                <Field label="Port (optional)" htmlFor="tv-port" description="Defaults to 5555.">
                  <Input
                    id="tv-port"
                    value={tvPort}
                    onChange={(e) => setTvPort(e.target.value)}
                    className="font-mono"
                    placeholder="5555"
                    inputMode="numeric"
                    disabled={!adbAvailable || installing}
                  />
                </Field>
                <Field
                  label="Pairing port (optional)"
                  htmlFor="tv-pair-port"
                  description="Android 11 and newer pair on their own port, shown on the TV."
                >
                  <Input
                    id="tv-pair-port"
                    value={tvPairPort}
                    onChange={(e) => setTvPairPort(e.target.value)}
                    className="font-mono"
                    placeholder="37251"
                    inputMode="numeric"
                    disabled={!adbAvailable || installing}
                  />
                </Field>
                <Field
                  label="Pairing code (optional)"
                  htmlFor="tv-pair-code"
                  description="The six digits shown next to the pairing port."
                  error={tvPairCodeInvalid ? "The pairing code is exactly six digits." : undefined}
                >
                  <Input
                    id="tv-pair-code"
                    value={tvPairCode}
                    onChange={(e) => setTvPairCode(e.target.value)}
                    className="font-mono"
                    placeholder="123456"
                    inputMode="numeric"
                    maxLength={6}
                    disabled={!adbAvailable || installing}
                  />
                </Field>
              </div>

              <Button
                onClick={installToTv}
                loading={installing}
                disabled={!adbAvailable || installing || !tvHost.trim() || !tvBuild || tvPairCodeInvalid}
              >
                {installing ? "Installing…" : "Install to TV"}
              </Button>

              {transcript && (
                <div className="space-y-1">
                  <p className={transcript.ok ? "text-xs text-emerald-400/90" : "text-xs text-red-400/90"}>
                    {transcript.ok ? "adb reported success" : "adb reported a failure"}
                  </p>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
                    {transcript.text}
                  </pre>
                </div>
              )}
            </>
          )}

          <HowTo title="How do I turn on network debugging on an Android TV?">
            <ol>
              <li>
                On the TV, open <strong>Settings</strong> and go to{" "}
                <strong>Device Preferences → About</strong>.
              </li>
              <li>
                Click <strong>Build</strong> seven times, until it says you are now a developer.
              </li>
              <li>
                Go back to <strong>Device Preferences → Developer options</strong> and turn on{" "}
                <strong>USB debugging</strong>, and <strong>Network debugging</strong> (also called
                Wireless debugging) if the TV has it.
              </li>
              <li>
                On Android 11 and newer, open <strong>Wireless debugging → Pair device with pairing
                code</strong> and enter the port and six-digit code it shows above.
              </li>
              <li>
                The first install prompts on the TV to allow this computer — accept it there.
              </li>
            </ol>
          </HowTo>
        </CardBody>
      </Card>
    </div>
  );
}
