"use client";

import { NetflixBrowse } from "@/components/netflix/netflix-browse";

export default function SeriesBrowsePage() {
  return (
    <NetflixBrowse
      heroCategory="series-trending"
      rows={[
        { title: "Trending Series", category: "series-trending" },
        { title: "Popular Series", category: "series-popular" },
        { title: "Top Rated Series", category: "series-top" },
        { title: "Recently Added", category: "recently-added" },
      ]}
    />
  );
}
