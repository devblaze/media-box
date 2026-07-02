"use client";

import { NetflixBrowse } from "@/components/netflix/netflix-browse";

/** Home browse: mixed trending hero over the core rows plus a Popular Anime row. */
export default function DiscoverPage() {
  return (
    <NetflixBrowse
      heroCategory="trending"
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
