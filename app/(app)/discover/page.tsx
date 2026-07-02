"use client";

import { useApi } from "@/lib/api";
import { NetflixBrowse } from "@/components/netflix/netflix-browse";
import { ContinueRow } from "@/components/netflix/continue-row";
// Type-only import: the service is a server module, erased from the client bundle.
import type { ContinueItem } from "@/server/playback/watch-progress-service";

/** Home browse: mixed trending hero over the core rows plus a Popular Anime row. */
export default function DiscoverPage() {
  // Fetch failures leave `data` undefined, so each ContinueRow simply renders nothing.
  const { data: continueItems } = useApi<ContinueItem[]>("/watch-progress/continue");
  const { data: recentItems } = useApi<ContinueItem[]>("/watch-progress/recent");

  return (
    <NetflixBrowse
      heroCategory="trending"
      leadingRows={
        <>
          <ContinueRow title="Continue Watching" items={continueItems} />
          <ContinueRow title="Recently Watched" items={recentItems} />
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
