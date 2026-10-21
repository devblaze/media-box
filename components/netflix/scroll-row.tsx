"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/** Width of one landscape card in a row: most of a phone, ~4½ on a desktop. */
export const ROW_CARD_CLASS = "w-[78vw] shrink-0 snap-start sm:w-[300px] lg:w-[340px]";

/**
 * A titled row that scrolls sideways: swipe or trackpad on its own, with round
 * arrow buttons on a desktop that page it by most of a screen and hide at either
 * end. Cards snap to the row's left edge so a swipe never stops half a card in.
 */
export function ScrollRow({
  title,
  actions,
  children,
}: {
  title: React.ReactNode;
  /** Controls at the right end of the heading (e.g. Edit). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    // Re-measure when the row resizes or its cards arrive (skeletons → titles).
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const cards = new MutationObserver(measure);
    cards.observe(el, { childList: true });
    return () => {
      resize.disconnect();
      cards.disconnect();
    };
  }, [measure]);

  function page(dir: -1 | 1) {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  }

  return (
    <section className="group/row relative">
      <div className="flex items-center justify-between gap-3 px-4 md:px-12">
        <h2 className="text-lg font-bold tracking-tight text-white md:text-xl">{title}</h2>
        {actions}
      </div>

      <div className="relative">
        <RowArrow dir={-1} hidden={edges.start} onClick={() => page(-1)} />
        <div
          ref={trackRef}
          onScroll={measure}
          className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pt-3 pb-5 md:scroll-px-12 md:px-12"
        >
          {children}
        </div>
        <RowArrow dir={1} hidden={edges.end} onClick={() => page(1)} />
      </div>
    </section>
  );
}

function RowArrow({ dir, hidden, onClick }: { dir: -1 | 1; hidden: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir < 0 ? "Scroll left" : "Scroll right"}
      tabIndex={hidden ? -1 : 0}
      className={cn(
        "absolute top-1/2 z-30 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 text-white shadow-xl ring-1 ring-white/20 backdrop-blur transition-all duration-200 hover:scale-110 hover:bg-black/90 md:flex",
        dir < 0 ? "left-3" : "right-3",
        hidden
          ? "pointer-events-none opacity-0"
          : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={dir < 0 ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
      </svg>
    </button>
  );
}
