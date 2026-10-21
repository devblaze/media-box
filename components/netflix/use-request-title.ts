"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui";
// Type-only import: the route is a server module, erased from the client bundle.
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/**
 * A Discover title's availability, plus the action that requests it. The status
 * is held locally so a fresh request flips the card at once, without a refetch.
 */
export function useRequestTitle(item: DiscoverItem) {
  const toast = useToast();
  const [status, setStatus] = useState(item.status);
  const [requesting, setRequesting] = useState(false);

  async function request() {
    setRequesting(true);
    try {
      const created = await apiFetch<{ status: string }>("/requests", {
        method: "POST",
        body: JSON.stringify({
          mediaType: item.mediaType,
          tmdbId: item.tmdbId,
          title: item.title,
          year: item.year,
          posterPath: item.posterPath,
        }),
      });
      setStatus("requested");
      toast.success(created.status === "pending" ? "Requested" : "Added to your library");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStatus("requested");
        toast.info("Already requested");
      } else {
        toast.error(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      setRequesting(false);
    }
  }

  return { status, requesting, request };
}

/** The in-library details page for a Discover title, or null when it isn't in the library. */
export function detailHrefFor(item: Pick<DiscoverItem, "mediaId" | "mediaType">): string | null {
  if (item.mediaId == null) return null;
  return item.mediaType === "movie" ? `/movies/${item.mediaId}` : `/series/${item.mediaId}`;
}
