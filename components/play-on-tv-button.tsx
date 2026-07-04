"use client";

import { useState } from "react";
import { useApi } from "@/lib/api";
import { Button } from "@/components/ui";

/**
 * "Play on TV" — a tokenized `/tv/watch/<type>/<id>?key=…` URL to open on a smart-TV
 * browser or a Fully Kiosk tablet, which plays this exact title full-screen with no
 * login (works over plain HTTP, unlike Chromecast). Renders as an icon button whose
 * popover shows the link to copy/open. Hidden until the cast token resolves.
 */
export function PlayOnTvButton({ type, id }: { type: "movie" | "episode"; id: number }) {
  const { data } = useApi<{ token: string }>("/cast");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const token = data?.token;
  if (!token) return null;
  const path = `/tv/watch/${type}/${id}?key=${token}`;

  function copyFull() {
    const url = `${window.location.origin}${path}`;
    void navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => {}
    );
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => {
          setOpen((o) => !o);
          setCopied(false);
        }}
        aria-label="Play on TV"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="4" width="20" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-white/10 bg-zinc-900/95 p-3 shadow-xl backdrop-blur"
        >
          <p className="text-xs text-zinc-400">
            Open this on a TV browser or a Fully Kiosk tablet — it plays full-screen, no login.
          </p>
          <input
            readOnly
            value={path}
            onFocus={(e) => e.target.select()}
            className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-300"
          />
          <div className="mt-2 flex items-center gap-2">
            <a
              href={path}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
            >
              Open ↗
            </a>
            <button
              type="button"
              onClick={copyFull}
              className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
            >
              {copied ? "Copied ✓" : "Copy full URL"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
