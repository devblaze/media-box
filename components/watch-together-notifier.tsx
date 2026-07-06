"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { useToast } from "@/components/ui";

/** Minimal slice of `/auth/me` this component needs. */
interface Me {
  seenStreamingHighlight: boolean;
}

/**
 * Cross-page watch-together listener, mounted once for every signed-in user:
 *   - Toasts the host when someone joins / leaves their shared stream
 *     (targeted `watch.peerJoined` / `watch.peerLeft` events).
 *   - Shows a one-time, dismissible highlight introducing the new "Share
 *     streaming activity" account setting (gated on `seenStreamingHighlight`),
 *     persisting the dismissal so it's shown at most once, ever, per user.
 */
export function WatchTogetherNotifier() {
  const toast = useToast();
  const { data: me, mutate } = useApi<Me>("/auth/me");

  // Host toasts on peer join/leave.
  const onEvent = useCallback(
    (e: { type: string; [key: string]: unknown }) => {
      if (e.type === "watch.peerJoined") {
        toast.info(`${String(e.joinerUsername)} joined your stream`);
      } else if (e.type === "watch.peerLeft") {
        toast.info(`${String(e.joinerUsername)} left your stream`);
      }
    },
    [toast]
  );
  useEvents(onEvent);

  // One-time onboarding highlight for the account setting. Derived from /auth/me
  // (shown until seen) plus a local dismissal so it hides immediately on click.
  const [dismissed, setDismissed] = useState(false);
  const showHighlight = !dismissed && me?.seenStreamingHighlight === false;

  const dismiss = useCallback(async () => {
    setDismissed(true);
    try {
      await apiFetch("/account", {
        method: "PUT",
        body: JSON.stringify({ seenStreamingHighlight: true }),
      });
      await mutate();
    } catch {
      /* best-effort — worst case it's shown once more next login */
    }
  }, [mutate]);

  if (!showHighlight) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[80] w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-red-500/30 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-lg" aria-hidden="true">
          🎬
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">New: Watch together</p>
          <p className="mt-1 text-xs text-zinc-400">
            Turn on <span className="font-medium text-zinc-200">Share streaming activity</span> in
            your account settings to let others join and watch in sync with you.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Link
              href="/account"
              onClick={() => void dismiss()}
              className="rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-500"
            >
              Open settings
            </Link>
            <button
              type="button"
              onClick={() => void dismiss()}
              className="rounded px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
