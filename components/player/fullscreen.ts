"use client";

import { useSyncExternalStore } from "react";

// Defensive against browsers without the promise-returning fullscreen API.

export function enterFullscreen(el: HTMLElement | null): void {
  try {
    const p = el?.requestFullscreen?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* fullscreen unsupported or rejected — keep playing windowed */
  }
}

export function exitFullscreen(): void {
  try {
    if (typeof document !== "undefined" && document.fullscreenElement) {
      const p = document.exitFullscreen?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

/** Whether the document is in native fullscreen, kept in step with the browser. */
export function useIsFullscreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!document.fullscreenElement,
    () => false
  );
}
