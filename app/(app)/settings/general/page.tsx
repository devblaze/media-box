"use client";

import { useEffect, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  HowTo,
  Input,
  Select,
  useToast,
} from "@/components/ui";

type HwAccel = "none" | "vaapi" | "qsv" | "nvenc";

interface AppSettings {
  tmdbApiKey: string;
  apiKey: string;
  logLevel: "debug" | "info" | "warn" | "error";
  urlBase: string;
  transcodeHwAccel: HwAccel;
  transcodeVaapiDevice: string;
  maxTranscodeSessions: number;
  pushoverAppToken: string;
}

export default function GeneralSettingsPage() {
  const { data, mutate } = useApi<AppSettings>("/settings");
  const toast = useToast();
  const [tmdbApiKey, setTmdbApiKey] = useState("");
  const [logLevel, setLogLevel] = useState<AppSettings["logLevel"]>("info");
  const [transcodeHwAccel, setTranscodeHwAccel] = useState<HwAccel>("none");
  const [transcodeVaapiDevice, setTranscodeVaapiDevice] = useState("/dev/dri/renderD128");
  const [maxTranscodeSessions, setMaxTranscodeSessions] = useState(3);
  const [pushoverAppToken, setPushoverAppToken] = useState("");
  const [testResult, setTestResult] = useState<null | { ok: boolean; message?: string }>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [transcodeTest, setTranscodeTest] = useState<null | {
    ok: boolean;
    ffmpegAvailable: boolean;
    message: string;
  }>(null);
  const [testingTranscode, setTestingTranscode] = useState(false);

  useEffect(() => {
    if (data) {
      setTmdbApiKey(data.tmdbApiKey);
      setLogLevel(data.logLevel);
      setTranscodeHwAccel(data.transcodeHwAccel);
      setTranscodeVaapiDevice(data.transcodeVaapiDevice);
      setMaxTranscodeSessions(data.maxTranscodeSessions);
      setPushoverAppToken(data.pushoverAppToken);
    }
  }, [data]);

  async function testTmdb() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; message?: string }>("/settings/tmdb-test", {
        method: "POST",
        body: JSON.stringify({ tmdbApiKey }),
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function testTranscode() {
    setTestingTranscode(true);
    setTranscodeTest(null);
    try {
      const result = await apiFetch<{ ok: boolean; ffmpegAvailable: boolean; message: string }>(
        "/settings/transcode-test",
        {
          method: "POST",
          body: JSON.stringify({ transcodeHwAccel, transcodeVaapiDevice }),
        }
      );
      setTranscodeTest(result);
    } catch (err) {
      setTranscodeTest({
        ok: false,
        ffmpegAvailable: false,
        message: err instanceof Error ? err.message : "Test failed",
      });
    } finally {
      setTestingTranscode(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({
          tmdbApiKey,
          logLevel,
          transcodeHwAccel,
          transcodeVaapiDevice,
          maxTranscodeSessions,
          pushoverAppToken,
        }),
      });
      await mutate();
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">General</h1>

      <Card>
        <CardHeader>
          <CardTitle>TMDB</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-zinc-400">
            Metadata for series and movies comes from The Movie Database. Get a free API key at
            themoviedb.org → Settings → API.
          </p>

          <HowTo title="How do I get a TMDB API key?">
            <ol>
              <li>
                Create a free account at{" "}
                <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer">
                  themoviedb.org
                </a>
                .
              </li>
              <li>
                Open your account menu and go to <strong>Settings → API</strong>.
              </li>
              <li>
                Request an <strong>API key (v3 auth)</strong> — choose the “Developer” option and fill
                in the short application form.
              </li>
              <li>
                Copy the <code>API Key (v3 auth)</code> value, paste it below, and click{" "}
                <strong>Test</strong> to verify it.
              </li>
            </ol>
          </HowTo>

          <Field label="API Key" htmlFor="tmdb-api-key">
            <Input
              id="tmdb-api-key"
              type="password"
              value={tmdbApiKey}
              onChange={(e) => setTmdbApiKey(e.target.value)}
              className="font-mono"
              placeholder="TMDB API key (v3)"
            />
          </Field>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={testTmdb}
              loading={testing}
              disabled={testing || !tmdbApiKey}
            >
              {testing ? "Testing…" : "Test"}
            </Button>
            {testResult && (
              <Badge tone={testResult.ok ? "success" : "danger"}>
                {testResult.ok ? "Key is valid" : (testResult.message ?? "Invalid key")}
              </Badge>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <Callout tone="info" title="External API access">
            This key authenticates external tools and integrations that talk to media-box. Treat it
            like a password and only share it with services you trust.
          </Callout>
          <Field label="API Key (for external tools; auto-generated)" htmlFor="external-api-key">
            <Input
              id="external-api-key"
              readOnly
              value={data?.apiKey ?? ""}
              className="font-mono text-zinc-400"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notifications (Pushover)</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Pushover app token" htmlFor="pushover-app-token">
            <Input
              id="pushover-app-token"
              value={pushoverAppToken}
              onChange={(e) => setPushoverAppToken(e.target.value)}
              className="font-mono"
              placeholder="Pushover Application API token"
            />
          </Field>
          <p className="text-sm text-zinc-400">
            Pushover Application API token. Each user then adds their personal user key under Account
            to receive request-available notifications.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
        </CardHeader>
        <CardBody>
          <Field label="Log level" htmlFor="log-level">
            <Select
              id="log-level"
              value={logLevel}
              onChange={(e) => setLogLevel(e.target.value as AppSettings["logLevel"])}
            >
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcoding</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-zinc-400">
            When a file is not directly playable in the browser (e.g. MKV, HEVC, non-AAC audio),
            media-box transcodes it on the fly to a browser-friendly HLS stream. Hardware
            acceleration offloads that work to your GPU.
          </p>

          <Field label="Hardware acceleration" htmlFor="transcode-hwaccel">
            <Select
              id="transcode-hwaccel"
              value={transcodeHwAccel}
              onChange={(e) => {
                setTranscodeHwAccel(e.target.value as HwAccel);
                setTranscodeTest(null);
              }}
            >
              <option value="none">None (CPU)</option>
              <option value="vaapi">Intel VAAPI</option>
              <option value="qsv">Intel QSV</option>
              <option value="nvenc">NVIDIA NVENC</option>
            </Select>
          </Field>

          {(transcodeHwAccel === "vaapi" || transcodeHwAccel === "qsv") && (
            <Field label="GPU render device" htmlFor="transcode-vaapi-device">
              <Input
                id="transcode-vaapi-device"
                value={transcodeVaapiDevice}
                onChange={(e) => {
                  setTranscodeVaapiDevice(e.target.value);
                  setTranscodeTest(null);
                }}
                className="font-mono"
                placeholder="/dev/dri/renderD128"
              />
              <p className="mt-1.5 text-xs text-zinc-500">
                Which GPU transcodes. Only matters with more than one — e.g. a dedicated
                transcode card next to an AI GPU. First GPU is usually{" "}
                <code className="text-zinc-400">/dev/dri/renderD128</code>, second{" "}
                <code className="text-zinc-400">/dev/dri/renderD129</code>. Run{" "}
                <code className="text-zinc-400">ls -l /dev/dri/by-path/</code> on the host to see
                which node is which card, then <strong>Test</strong> to confirm.
              </p>
            </Field>
          )}

          <Field label="Max concurrent transcodes" htmlFor="transcode-max-sessions">
            <Input
              id="transcode-max-sessions"
              type="number"
              min={1}
              max={10}
              value={maxTranscodeSessions}
              onChange={(e) => setMaxTranscodeSessions(Number(e.target.value))}
            />
          </Field>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={testTranscode}
                loading={testingTranscode}
                disabled={testingTranscode}
              >
                {testingTranscode ? "Testing…" : "Test"}
              </Button>
              {transcodeTest && (
                <Badge tone={transcodeTest.ok ? "success" : "danger"}>
                  {transcodeTest.ok
                    ? transcodeHwAccel === "none"
                      ? "Software encoding works"
                      : "Hardware acceleration works"
                    : transcodeTest.ffmpegAvailable
                      ? "Not working"
                      : "ffmpeg missing"}
                </Badge>
              )}
            </div>
            {transcodeTest && (
              <p className={transcodeTest.ok ? "text-xs text-emerald-400/90" : "text-xs text-red-400/90"}>
                {transcodeTest.message}
              </p>
            )}
            <p className="text-xs text-zinc-500">
              Runs a quick encode with the selected mode to confirm it works. Test the mode before
              saving; hardware modes need the GPU passed through to the container.
            </p>
          </div>

          <HowTo title="GPU transcoding (Unraid passthrough)">
            <p>
              media-box uses <code>ffmpeg</code> inside the container. Hardware acceleration only
              works if the GPU is passed through to the container.
            </p>
            <ul>
              <li>
                <strong>Intel / AMD (VAAPI &amp; QSV):</strong> add the device to the container with{" "}
                <code>--device=/dev/dri</code> (Unraid: add a <em>Device</em> with value{" "}
                <code>/dev/dri</code>), and make sure the container user is in the host{" "}
                <code>render</code> (and <code>video</code>) group so it can access{" "}
                <code>/dev/dri/renderD128</code>.
              </li>
              <li>
                <strong>NVIDIA (NVENC):</strong> install the <em>Unraid Nvidia</em> plugin, then run
                the container with <code>--runtime=nvidia</code> and{" "}
                <code>NVIDIA_VISIBLE_DEVICES=all</code> (or a specific GPU UUID). Extra parameters in
                the Unraid template: <code>--runtime=nvidia</code>.
              </li>
            </ul>
          </HowTo>
        </CardBody>
      </Card>

      <Button onClick={save} loading={saving} disabled={saving || !data}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
