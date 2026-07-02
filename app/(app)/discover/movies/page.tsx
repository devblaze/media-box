"use client";

import { NetflixBrowse } from "@/components/netflix/netflix-browse";

export default function MoviesBrowsePage() {
  return (
    <NetflixBrowse
      heroCategory="movies-trending"
      rows={[
        { title: "Trending Movies", category: "movies-trending" },
        { title: "Popular Movies", category: "movies-popular" },
        { title: "Top Rated Movies", category: "movies-top" },
        { title: "Recently Added", category: "recently-added" },
      ]}
    />
  );
}
