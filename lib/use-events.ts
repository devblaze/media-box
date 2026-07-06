"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";

interface AppEvent {
  type: string;
  [key: string]: unknown;
}

// Maps event types to the SWR keys they invalidate.
const INVALIDATIONS: Record<string, string[]> = {
  "command.updated": ["/command", "/system/tasks"],
  // /requests too: the requests list derives its status badge (searching →
  // downloading → importing → failed) from the live download state.
  "queue.updated": ["/queue", "/requests"],
  "series.updated": ["/series"],
  "movie.updated": ["/movies"],
  "history.added": ["/history"],
  "request.updated": ["/requests"],
};

export function useEvents(onEvent?: (event: AppEvent) => void) {
  const { mutate } = useSWRConfig();

  useEffect(() => {
    const source = new EventSource("/api/v1/system/events");
    source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as AppEvent;
        for (const key of INVALIDATIONS[event.type] ?? []) {
          void mutate((k) => typeof k === "string" && k.startsWith(key), undefined, {
            revalidate: true,
          });
        }
        onEvent?.(event);
      } catch {
        // ignore malformed events
      }
    };
    return () => source.close();
  }, [mutate, onEvent]);
}
