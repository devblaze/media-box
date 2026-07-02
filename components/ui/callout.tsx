import { cn } from "@/lib/cn";

type Tone = "info" | "tip" | "warning" | "danger";

const TONES: Record<Tone, { box: string; icon: string; glyph: string }> = {
  info: { box: "border-sky-500/25 bg-sky-500/5", icon: "text-sky-400", glyph: "i" },
  tip: { box: "border-amber-500/25 bg-amber-500/5", icon: "text-amber-400", glyph: "★" },
  warning: { box: "border-yellow-500/25 bg-yellow-500/5", icon: "text-yellow-400", glyph: "!" },
  danger: { box: "border-red-500/25 bg-red-500/5", icon: "text-red-400", glyph: "!" },
};

/** Static coloured note box for short, always-visible guidance. */
export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <div className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-sm", t.box, className)}>
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-current text-xs font-bold",
          t.icon
        )}
        aria-hidden="true"
      >
        {t.glyph}
      </span>
      <div className="space-y-1 text-zinc-300">
        {title && <p className="font-medium text-zinc-100">{title}</p>}
        <div className="[&_a]:text-amber-300 [&_a]:underline [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Collapsible "how do I…" guide. Uses native <details> so it works without JS. */
export function HowTo({
  title = "How do I set this up?",
  children,
  defaultOpen = false,
  className,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm [&[open]]:bg-zinc-900/60",
        className
      )}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3.5 py-2.5 font-medium text-zinc-200 marker:content-none hover:text-amber-300">
        <svg
          className="size-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-90"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M7 5l6 5-6 5V5z" />
        </svg>
        {title}
      </summary>
      <div className="space-y-2 px-3.5 pb-3.5 pl-9 text-zinc-400 [&_a]:text-amber-300 [&_a]:underline [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_li]:ml-4 [&_li]:list-disc [&_ol>li]:list-decimal [&_strong]:text-zinc-200">
        {children}
      </div>
    </details>
  );
}
