"use client";

import { useApi } from "@/lib/api";
import { NetflixBrowse } from "@/components/netflix/netflix-browse";
import { NetflixRow } from "@/components/netflix/netflix-row";
import { ContinueRow } from "@/components/netflix/continue-row";
// Type-only imports: these are server modules, erased from the client bundle.
import type { ContinueItem } from "@/server/playback/watch-progress-service";
import type { RecommendationGroup } from "@/server/metadata/recommendations";

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
