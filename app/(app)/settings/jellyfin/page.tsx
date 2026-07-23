"use client";

import { useEffect, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  useToast,
} from "@/components/ui";

/** Subset of app settings this page reads. */
interface JellyfinSettings {
  jellyfinUrl?: string;
}

type TestResult =
  | { ok: true; serverName: string; version: string | null }
  | { ok: false; message: string };

export default function JellyfinSettingsPage() {
  const { data, mutate } = useApi<JellyfinSettings>("/settings");
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Prefill from settings once they load, without clobbering what's being typed.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data && !seeded) {
      setUrl(data.jellyfinUrl ?? "");
      setSeeded(true);
    }
  }, [data, seeded]);

  async function test() {
    setTesting(true);
    try {
      const result = await apiFetch<TestResult>("/jellyfin/test", {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      if (result.ok) {
        toast.success(
          `Connected to ${result.serverName}${result.version ? ` (v${result.version})` : ""}`
        );
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({ jellyfinUrl: url.trim() }),
      });
      await mutate();
      toast.success("Jellyfin server saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold">Jellyfin</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Sync users&apos; watch progress from a Jellyfin server.
      </p>

      <Callout tone="info" title="How it works" className="mt-4">
        <p>
          Set the Jellyfin server URL here, then each user links their own Jellyfin account from
          their <a href="/account">Account page</a>. Watch progress (Continue Watching / Next Up)
          syncs automatically every 30 minutes and on demand.
        </p>
      </Callout>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Server</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Server URL" htmlFor="jellyfin-url">
            <Input
              id="jellyfin-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="font-mono"
              placeholder="http://192.168.1.10:8096"
            />
          </Field>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={test}
              loading={testing}
              disabled={testing || !url.trim()}
            >
              {testing ? "Testing…" : "Test"}
            </Button>
            <Button
              size="sm"
              onClick={save}
              loading={saving}
              disabled={saving || !url.trim()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
