"use client";

import { cn } from "@/lib/cn";

/** A pop-up menu above its trigger in the control bar (opens upward, so it isn't
 *  clipped at the bottom edge). */
export function MenuPanel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="menu"
      className={cn(
        "absolute right-0 bottom-full mb-2 max-h-72 min-w-44 overflow-auto rounded-md border border-white/10 bg-zinc-900/95 py-1 shadow-xl backdrop-blur",
        className
      )}
    >
      {children}
    </div>
  );
}

export function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
      {children}
    </p>
  );
}

/** One radio-style choice in a {@link MenuPanel}. */
export function MenuItem({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/10",
        active ? "text-amber-400" : "text-zinc-200"
      )}
    >
      <span className="w-3 shrink-0 text-amber-400" aria-hidden="true">
        {active ? "✓" : ""}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The bordered text chips in the control bar (mode, stream quality, file quality). */
export function chipClass(highlighted: boolean): string {
  return cn(
    "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
    highlighted
      ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
      : "border-white/15 text-zinc-300 hover:bg-white/10"
  );
}
