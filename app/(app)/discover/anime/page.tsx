"use client";

import { NetflixBrowse } from "@/components/netflix/netflix-browse";

export default function AnimeBrowsePage() {
  return (
    <NetflixBrowse
      heroCategory="anime-popular"
      rows={[
        { title: "Popular Anime", category: "anime-popular" },
        { title: "New Anime", category: "anime-new" },
        { title: "Top Rated Anime", category: "anime-top" },
        { title: "Anime Movies", category: "anime-movies" },
      ]}
    />
  );
}
