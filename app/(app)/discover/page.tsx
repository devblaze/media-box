"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { NetflixBrowse } from "@/components/netflix/netflix-browse";
import { NetflixRow } from "@/components/netflix/netflix-row";
import { ContinueRow } from "@/components/netflix/continue-row";
// Type-only imports: these are server modules, erased from the client bundle.
import type { ContinueItem } from "@/server/playback/watch-progress-service";
import type { RecommendationGroup } from "@/server/metadata/recommendations";

const JELLYFIN_PROMPT_DISMISSED_KEY = "mediabox:jellyfin-prompt-dismissed";

// Cross-tab changes only — a same-tab dismissal is covered by local state below.
function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * Slim one-line nudge to link a Jellyfin account. Shown only while an admin has
 * configured a server and this user hasn't linked (or dismissed the prompt).
 * Dismissal persists in localStorage, read via useSyncExternalStore whose server
 * snapshot reports "dismissed" so SSR and hydration render nothing.
 */
function JellyfinPromptBanner() {
  const { data } = useApi<{ configured: boolean; linked: boolean }>("/jellyfin");
  const storedDismissed = useSyncExternalStore(
    subscribeToStorage,
    () => localStorage.getItem(JELLYFIN_PROMPT_DISMISSED_KEY) === "1",
    () => true
  );
  const [justDismissed, setJustDismissed] = useState(false);

  if (justDismissed || storedDismissed || !data?.configured || data.linked) return null;

  return (
    <div className="px-4 md:px-12">
      <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/80 px-4 py-2.5 backdrop-blur">
        <p className="min-w-0 flex-1 text-sm text-zinc-300">
          Sync your Jellyfin watch progress — connect your account to pick up where you left off.
        </p>
        <Link
          href="/account"
          className="shrink-0 rounded-md border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-800"
        >
          Connect
        </Link>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            localStorage.setItem(JELLYFIN_PROMPT_DISMISSED_KEY, "1");
            setJustDismissed(true);
          }}
          className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** Home browse: trending hero over Continue Watching, "Because you watched…", and the core rows. */
export default function DiscoverPage() {
  // Fetch failures leave the data undefined, so each row simply renders nothing.
  const { data: continueItems } = useApi<ContinueItem[]>("/watch-progress/continue");
  const { data: recommendations } = useApi<RecommendationGroup[]>("/discover/recommendations");

  return (
    <NetflixBrowse
      heroCategory="trending"
      leadingRows={
        <>
          <JellyfinPromptBanner />
          <ContinueRow title="Continue Watching" items={continueItems} />
          {recommendations?.map((group) => (
            <NetflixRow
              key={`${group.basedOn.mediaType}-${group.basedOn.tmdbId}`}
              title={`Because you watched ${group.basedOn.title}`}
              items={group.items}
            />
          ))}
        </>
      }
      rows={[
        { title: "Recently Added", category: "recently-added" },
        { title: "Trending Now", category: "trending" },
        { title: "Popular Movies", category: "popular-movies" },
        { title: "Popular Series", category: "popular-series" },
        { title: "Popular Anime", category: "anime-popular" },
      ]}
    />
  );
}
