"use client";

import { useEffect, useRef } from "react";
import { mutate } from "swr";

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
  // Held file changes (Ask mode) — refresh the approvals list on new/decided items.
  "fileChange.pending": ["/file-changes"],
  "fileChange.updated": ["/file-changes"],
};

// One shared EventSource for the whole app. Long-lived SSE GETs count against
// the browser's ~6-per-host connection limit, so one connection per useEvents()
// caller starves regular fetches and images.
type Listener = { current: ((event: AppEvent) => void) | undefined };

let source: EventSource | null = null;
const listeners = new Set<Listener>();

function handleMessage(msg: MessageEvent) {
  try {
    const event = JSON.parse(msg.data) as AppEvent;
    // Invalidate once per event, not once per subscriber. No data argument:
    // revalidate in place so stale data stays visible instead of blanking to
    // a loading state.
    for (const key of INVALIDATIONS[event.type] ?? []) {
      void mutate((k) => typeof k === "string" && k.startsWith(key));
    }
    for (const listener of listeners) listener.current?.(event);
  } catch {
    // ignore malformed events
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) {
    source = new EventSource("/api/v1/system/events");
    source.onmessage = handleMessage;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
    }
  };
}

export function useEvents(onEvent?: (event: AppEvent) => void) {
  // Latest-callback ref: a new onEvent identity must not reconnect anything.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => subscribe(onEventRef), []);
}
