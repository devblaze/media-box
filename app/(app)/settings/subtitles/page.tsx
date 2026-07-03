"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, useApi } from "@/lib/api";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  HowTo,
  Input,
  Skeleton,
  Switch,
  useToast,
} from "@/components/ui";

interface SubtitleSettings {
  subtitleLanguages: string;
  subtitleHearingImpaired: boolean;
  subtitleProviders: string;
  openSubtitlesApiKey: string;
  openSubtitlesUsername: string;
  openSubtitlesPassword: string;
}

interface Provider {
  id: string;
  name: string;
  description: string;
  needsConfig: boolean;
  specializes: string[];
  enabled: boolean;
  ready: boolean;
}

interface FormState {
  subtitleLanguages: string;
  subtitleHearingImpaired: boolean;
  openSubtitlesApiKey: string;
  openSubtitlesUsername: string;
  openSubtitlesPassword: string;
  /** All provider ids in priority order (enabled subset = saved value). */
  order: string[];
  enabled: Record<string, boolean>;
}

/** Human-readable labels for ISO-639-1 codes a provider can specialise in. */
const LANG_LABELS: Record<string, string> = {
  el: "Greek",
};

/** Per-provider setup instructions + recommendation, shown inline on each card. */
const SETUP: Record<string, { recommended?: boolean; guide: ReactNode }> = {
  opensubtitles: {
    recommended: true,
    guide: (
      <>
        <ol>
          <li>
            Create a free account at{" "}
            <a href="https://www.opensubtitles.com" target="_blank" rel="noreferrer">
              opensubtitles.com
            </a>
            .
          </li>
          <li>
            Open your profile → <strong>API</strong> → create a new <strong>API Consumer</strong> to
            get an <strong>API key</strong>.
          </li>
          <li>
            Paste the API key below, plus your account <strong>username</strong> and{" "}
            <strong>password</strong> (both are needed to download subtitles).
          </li>
        </ol>
        <p>
          Largest subtitle database and includes Greek — recommended as your{" "}
          <strong>primary</strong> provider.
        </p>
      </>
    ),
  },
  opensubtitlesorg: {
    guide: (
      <p>
        No signup required — just enable it. A solid free fallback with broad coverage, including
        Greek.
      </p>
    ),
  },
  podnapisi: {
    guide: (
      <p>
        No signup required — just enable it. Strong multi-language coverage, including Greek.
      </p>
    ),
  },
  subs4free: {
    guide: (
      <p>
        No signup required — enable it for <strong>Greek</strong> content. Community-run site, so
        availability is best-effort.
      </p>
    ),
  },
};

export default function SubtitlesSettingsPage() {
  const { data: settings, mutate: mutateSettings } = useApi<SubtitleSettings>("/settings");
  const { data: providers, mutate: mutateProviders } = useApi<Provider[]>("/subtitles/providers");
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (form || !settings || !providers) return;

    const known = new Set(providers.map((p) => p.id));
    const savedOrder = (settings.subtitleProviders ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((id) => id && known.has(id));
    // Saved priority order first, then any remaining providers in default order.
    const order = [...savedOrder, ...providers.map((p) => p.id).filter((id) => !savedOrder.includes(id))];

    const enabled: Record<string, boolean> = {};
    for (const p of providers) enabled[p.id] = p.enabled || savedOrder.includes(p.id);

    setForm({
      subtitleLanguages: settings.subtitleLanguages ?? "",
      subtitleHearingImpaired: settings.subtitleHearingImpaired ?? false,
      openSubtitlesApiKey: settings.openSubtitlesApiKey ?? "",
      openSubtitlesUsername: settings.openSubtitlesUsername ?? "",
      openSubtitlesPassword: settings.openSubtitlesPassword ?? "",
      order,
      enabled,
    });
  }, [form, settings, providers]);

  const byId = new Map((providers ?? []).map((p) => [p.id, p]));

  /** Reorder among the enabled providers only (priority = order they win in). */
  function move(id: string, dir: -1 | 1) {
    setForm((f) => {
      if (!f) return f;
      const order = [...f.order];
      const enabledIds = order.filter((x) => f.enabled[x]);
      const pos = enabledIds.indexOf(id);
      const swapWith = enabledIds[pos + dir];
      if (!swapWith) return f;
      const i = order.indexOf(id);
      const j = order.indexOf(swapWith);
      [order[i], order[j]] = [order[j], order[i]];
      return { ...f, order };
    });
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const subtitleProviders = form.order.filter((id) => form.enabled[id]).join(",");
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({
          subtitleLanguages: form.subtitleLanguages,
          subtitleHearingImpaired: form.subtitleHearingImpaired,
          openSubtitlesApiKey: form.openSubtitlesApiKey,
          openSubtitlesUsername: form.openSubtitlesUsername,
          openSubtitlesPassword: form.openSubtitlesPassword,
          subtitleProviders,
        }),
      });
      await Promise.all([mutateSettings(), mutateProviders()]);
      toast.success("Subtitle settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  const enabledOrder = form ? form.order.filter((id) => form.enabled[id]) : [];

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Subtitles</h1>

      <p className="text-sm text-zinc-400">
        media-box downloads subtitles as <strong>sidecar files</strong> saved right next to each
        video (e.g. <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">Movie (2024).en.srt</code>
        ), so any player picks them up automatically. A daily task refreshes subtitles for monitored
        titles that are still missing them.
      </p>

      {!form ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      ) : (
        <>
          {/* 1. Wanted languages + hearing impaired */}
          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold text-zinc-100">Wanted languages</h2>
            </CardHeader>
            <CardBody className="space-y-4">
              <Field
                label="Subtitle languages"
                htmlFor="subtitle-languages"
                description={
                  <>
                    Comma-separated ISO-639-1 codes, e.g.{" "}
                    <code className="rounded bg-zinc-800 px-1 py-0.5">en,el</code>.{" "}
                    <code className="rounded bg-zinc-800 px-1 py-0.5">el</code> = Greek.
                  </>
                }
              >
                <Input
                  id="subtitle-languages"
                  value={form.subtitleLanguages}
                  onChange={(e) => setForm({ ...form, subtitleLanguages: e.target.value })}
                  placeholder="en,el"
                />
              </Field>

              <Field label="Hearing impaired" description="Prefer/allow SDH subtitles.">
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <Checkbox
                    checked={form.subtitleHearingImpaired}
                    onChange={(e) => setForm({ ...form, subtitleHearingImpaired: e.target.checked })}
                  />
                  Include hearing-impaired (SDH) subtitles
                </label>
              </Field>
            </CardBody>
          </Card>

          {/* Greek recommendation */}
          <Callout tone="tip" title="For Greek subtitles">
            Add <code>el</code> to Wanted languages and enable{" "}
            <strong>OpenSubtitles</strong> + <strong>Subs4Free</strong> (and{" "}
            <strong>Podnapisi</strong>). media-box tries enabled providers in priority order and uses
            the first one that has a match.
          </Callout>

          {/* 2. Providers */}
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-zinc-100">Providers</h2>
            <p className="text-xs text-zinc-500">
              Enable one or more providers and set their priority. The first enabled provider with a
              match wins.
            </p>
          </div>

          <div className="space-y-3">
            {form.order.map((id) => {
              const p = byId.get(id);
              if (!p) return null;
              const isEnabled = form.enabled[id];
              const priority = enabledOrder.indexOf(id);
              const setup = SETUP[id];

              const status = p.needsConfig ? (
                p.ready ? (
                  <Badge tone="success">Configured</Badge>
                ) : (
                  <Badge tone="warning">Needs API key</Badge>
                )
              ) : (
                <Badge tone="neutral">Free · no setup</Badge>
              );

              return (
                <Card key={id} className={isEnabled ? "border-amber-500/30" : undefined}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      {isEnabled && priority >= 0 && (
                        <Badge tone="accent" title="Priority order">
                          #{priority + 1}
                        </Badge>
                      )}
                      <span className="text-sm font-semibold text-zinc-100">{p.name}</span>
                      {setup?.recommended && <Badge tone="accent">Recommended</Badge>}
                      {p.specializes.map((code) => (
                        <Badge key={code} tone="success">
                          {LANG_LABELS[code] ?? code.toUpperCase()}
                        </Badge>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      {status}
                      {isEnabled && (
                        <div className="flex items-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Increase ${p.name} priority`}
                            title="Move up (higher priority)"
                            disabled={priority <= 0}
                            onClick={() => move(id, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Decrease ${p.name} priority`}
                            title="Move down (lower priority)"
                            disabled={priority < 0 || priority >= enabledOrder.length - 1}
                            onClick={() => move(id, 1)}
                          >
                            ↓
                          </Button>
                        </div>
                      )}
                      <Switch
                        checked={isEnabled}
                        onChange={(checked) =>
                          setForm({ ...form, enabled: { ...form.enabled, [id]: checked } })
                        }
                        aria-label={`Enable ${p.name}`}
                      />
                    </div>
                  </CardHeader>

                  <CardBody className="space-y-3">
                    <p className="text-sm text-zinc-400">{p.description}</p>

                    {p.needsConfig && id === "opensubtitles" && (
                      <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
                        <Field label="API key" htmlFor="opensubtitles-api-key">
                          <Input
                            id="opensubtitles-api-key"
                            value={form.openSubtitlesApiKey}
                            onChange={(e) =>
                              setForm({ ...form, openSubtitlesApiKey: e.target.value })
                            }
                            className="font-mono"
                            placeholder="OpenSubtitles API key"
                          />
                        </Field>
                        <Field label="Username" htmlFor="opensubtitles-username">
                          <Input
                            id="opensubtitles-username"
                            value={form.openSubtitlesUsername}
                            onChange={(e) =>
                              setForm({ ...form, openSubtitlesUsername: e.target.value })
                            }
                            placeholder="OpenSubtitles username"
                          />
                        </Field>
                        <Field label="Password" htmlFor="opensubtitles-password">
                          <Input
                            id="opensubtitles-password"
                            type="password"
                            value={form.openSubtitlesPassword}
                            onChange={(e) =>
                              setForm({ ...form, openSubtitlesPassword: e.target.value })
                            }
                            placeholder="OpenSubtitles password"
                          />
                        </Field>
                      </div>
                    )}

                    {setup && (
                      <HowTo title={`How to set up ${p.name}`}>{setup.guide}</HowTo>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>

          <div className="flex justify-end">
            <Button onClick={save} loading={saving} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
