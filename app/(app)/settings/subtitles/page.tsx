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
  Checkbox,
  Field,
  Input,
  Select,
  Skeleton,
  useToast,
} from "@/components/ui";

type SubtitleProvider = "none" | "opensubtitles";

interface SubtitleSettings {
  subtitleLanguages: string;
  subtitleProvider: SubtitleProvider;
  subtitleHearingImpaired: boolean;
  openSubtitlesApiKey: string;
  openSubtitlesUsername: string;
  openSubtitlesPassword: string;
}

export default function SubtitlesSettingsPage() {
  const { data, mutate } = useApi<SubtitleSettings>("/settings");
  const [form, setForm] = useState<SubtitleSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (data && !form) {
      setForm({
        subtitleLanguages: data.subtitleLanguages ?? "",
        subtitleProvider: data.subtitleProvider ?? "none",
        subtitleHearingImpaired: data.subtitleHearingImpaired ?? false,
        openSubtitlesApiKey: data.openSubtitlesApiKey ?? "",
        openSubtitlesUsername: data.openSubtitlesUsername ?? "",
        openSubtitlesPassword: data.openSubtitlesPassword ?? "",
      });
    }
  }, [data, form]);

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({
          subtitleLanguages: form.subtitleLanguages,
          subtitleProvider: form.subtitleProvider,
          subtitleHearingImpaired: form.subtitleHearingImpaired,
          openSubtitlesApiKey: form.openSubtitlesApiKey,
          openSubtitlesUsername: form.openSubtitlesUsername,
          openSubtitlesPassword: form.openSubtitlesPassword,
        }),
      });
      await mutate();
      toast.success("Subtitle settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">Subtitles</h1>

      <Card>
        <CardHeader>
          <CardTitle>Subtitles</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-zinc-400">
            media-box downloads subtitles as <strong>sidecar files</strong> saved right next to each
            video (e.g. <code>Movie (2024).en.srt</code>), so any player picks them up automatically.
            A daily task refreshes subtitles for monitored titles that are still missing them.
          </p>

          {!form ? (
            <div className="space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <>
              <Field
                label="Subtitle languages"
                htmlFor="subtitle-languages"
                description="Comma-separated ISO-639-1 codes, e.g. en,es,fr"
              >
                <Input
                  id="subtitle-languages"
                  value={form.subtitleLanguages}
                  onChange={(e) => setForm({ ...form, subtitleLanguages: e.target.value })}
                  placeholder="en,es,fr"
                />
              </Field>

              <Field
                label="Provider"
                htmlFor="subtitle-provider"
                description="Where subtitles are downloaded from."
              >
                <Select
                  id="subtitle-provider"
                  value={form.subtitleProvider}
                  onChange={(e) =>
                    setForm({ ...form, subtitleProvider: e.target.value as SubtitleProvider })
                  }
                >
                  <option value="none">None</option>
                  <option value="opensubtitles">OpenSubtitles</option>
                </Select>
              </Field>

              {form.subtitleProvider === "opensubtitles" && (
                <>
                  <Field label="API key" htmlFor="opensubtitles-api-key">
                    <Input
                      id="opensubtitles-api-key"
                      value={form.openSubtitlesApiKey}
                      onChange={(e) => setForm({ ...form, openSubtitlesApiKey: e.target.value })}
                      className="font-mono"
                      placeholder="OpenSubtitles API key"
                    />
                  </Field>

                  <Field label="Username" htmlFor="opensubtitles-username">
                    <Input
                      id="opensubtitles-username"
                      value={form.openSubtitlesUsername}
                      onChange={(e) => setForm({ ...form, openSubtitlesUsername: e.target.value })}
                      placeholder="OpenSubtitles username"
                    />
                  </Field>

                  <Field label="Password" htmlFor="opensubtitles-password">
                    <Input
                      id="opensubtitles-password"
                      type="password"
                      value={form.openSubtitlesPassword}
                      onChange={(e) => setForm({ ...form, openSubtitlesPassword: e.target.value })}
                      placeholder="OpenSubtitles password"
                    />
                  </Field>

                  <Field label="Hearing impaired" description="Prefer/allow SDH subtitles">
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <Checkbox
                        checked={form.subtitleHearingImpaired}
                        onChange={(e) =>
                          setForm({ ...form, subtitleHearingImpaired: e.target.checked })
                        }
                      />
                      Include hearing-impaired (SDH) subtitles
                    </label>
                  </Field>
                </>
              )}

              <Callout tone="info" title="Provider account required">
                OpenSubtitles needs a free account and an API key. Create one at{" "}
                <a href="https://www.opensubtitles.com" target="_blank" rel="noreferrer">
                  opensubtitles.com
                </a>{" "}
                and generate an API key under your account&apos;s consumer/API settings.
              </Callout>
            </>
          )}
        </CardBody>
      </Card>

      <Button onClick={save} loading={saving} disabled={saving || !form}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
