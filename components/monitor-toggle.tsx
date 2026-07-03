"use client";

import { cn } from "@/lib/cn";

/**
 * A switch-style monitored control: green when on, zinc when off. Dims while a
 * request is in flight (`pending`). Distinct from the kit's amber <Switch> so
 * "monitored" reads as a status colour rather than a brand accent.
 */
export function MonitorToggle({
  checked,
  onChange,
  pending,
  disabled,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  pending?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled || pending}
      onClick={() => onChange(!checked)}
      title={checked ? "Monitored — click to unmonitor" : "Not monitored — click to monitor"}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:cursor-not-allowed",
        checked ? "bg-emerald-500" : "bg-zinc-700",
        pending && "opacity-60"
      )}
    >
      <span
        className={cn(
          "inline-block size-5 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
