import { getSettings } from "@/server/settings/settings-service";
import type { SubtitleProvider } from "./types";
import { opensubtitlesProvider } from "./opensubtitles";
import { opensubtitlesOrgProvider } from "./opensubtitles-org";
import { podnapisiProvider } from "./podnapisi";
import { subs4freeProvider } from "./subs4free";

/** Every known provider, in a sensible default priority order. */
export const ALL_PROVIDERS: SubtitleProvider[] = [
  opensubtitlesProvider,
  opensubtitlesOrgProvider,
  podnapisiProvider,
  subs4freeProvider,
];

export function providerById(id: string): SubtitleProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

/** Enabled provider ids in user-chosen priority order (back-compat with the old single enum). */
export function enabledProviderIds(): string[] {
  const s = getSettings();
  if (s.subtitleProviders) {
    return s.subtitleProviders
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (s.subtitleProvider === "opensubtitles") return ["opensubtitles"];
  return [];
}

/** Enabled + ready providers, in priority order. */
export function enabledProviders(): SubtitleProvider[] {
  const seen = new Set<string>();
  const out: SubtitleProvider[] = [];
  for (const id of enabledProviderIds()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = providerById(id);
    if (p && p.isReady()) out.push(p);
  }
  return out;
}
