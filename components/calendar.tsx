"use client";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local-time day key (year-month-date) — safe for grouping/looking up cells. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** True when two dates fall on the same local calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Every day cell the month grid renders for `month` — the days of that month
 * plus the leading/trailing days needed to fill whole weeks (Sun–Sat). Each
 * entry is at local midnight. This is the single source of truth for the grid
 * range, so a page can use `getCalendarDays(month)[0]` … `.at(-1)` to compute
 * the exact window it needs to fetch. No `Date.now()` — derived only from `month`.
 */
export function getCalendarDays(month: Date): Date[] {
  const year = month.getFullYear();
  const m = month.getMonth();
  const leading = new Date(year, m, 1).getDay(); // 0 = Sun … 6 = Sat
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const cells = Math.ceil((leading + daysInMonth) / 7) * 7;
  // `new Date(year, m, n)` normalizes out-of-range days across month boundaries.
  return Array.from({ length: cells }, (_, i) => new Date(year, m, 1 - leading + i));
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface CalendarProps {
  /** Any day within the month to display. */
  month: Date;
  /** Called with the first day of the target month for the ‹ / Today / › controls. */
  onMonthChange: (next: Date) => void;
  /** Content rendered inside a day cell, below the day number. May return null. */
  renderDay?: (day: Date) => React.ReactNode;
  /** Optional: makes each in-grid cell clickable. */
  onDayClick?: (day: Date) => void;
  /** Optional day to fill-highlight as selected. */
  selectedDay?: Date;
  className?: string;
}

/**
 * Presentational month grid (Sun–Sat). Generic on purpose so both the public
 * schedule calendar and a future admin failures calendar can drive it with
 * their own `renderDay`. Today is ring-highlighted, `selectedDay` is
 * fill-highlighted, and leading/trailing days of adjacent months are dimmed.
 * The grid keeps a fixed min width and scrolls horizontally inside its own
 * wrapper on narrow screens; each cell scrolls internally when its content
 * overflows.
 */
export function Calendar({
  month,
  onMonthChange,
  renderDay,
  onDayClick,
  selectedDay,
  className,
}: CalendarProps) {
  const today = new Date();
  const year = month.getFullYear();
  const m = month.getMonth();
  const days = getCalendarDays(month);
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className={className}>
      {/* Header: month/year + prev / today / next */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{monthLabel}</h2>
        <div className="flex items-center gap-1.5">
          <Button
            size="icon"
            variant="secondary"
            aria-label="Previous month"
            onClick={() => onMonthChange(new Date(year, m - 1, 1))}
          >
            <ChevronLeft />
          </Button>
          <Button size="sm" variant="outline" onClick={() => onMonthChange(new Date())}>
            Today
          </Button>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Next month"
            onClick={() => onMonthChange(new Date(year, m + 1, 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {/* Horizontal scroll on narrow screens */}
      <div className="overflow-x-auto">
        <div className="min-w-[44rem]">
          {/* Weekday header row */}
          <div className="grid grid-cols-7 border-b border-white/10">
            {WEEKDAYS.map((label) => (
              <div
                key={label}
                className="px-2 py-1.5 text-center text-xs font-medium tracking-wide text-zinc-400"
              >
                {label}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const inMonth = day.getMonth() === m;
              const today_ = isSameDay(day, today);
              const selected = selectedDay ? isSameDay(day, selectedDay) : false;
              const clickable = Boolean(onDayClick);
              const content = renderDay?.(day);

              return (
                <div
                  key={day.getTime()}
                  {...(clickable
                    ? {
                        role: "button",
                        tabIndex: 0,
                        onClick: () => onDayClick?.(day),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onDayClick?.(day);
                          }
                        },
                      }
                    : {})}
                  className={cn(
                    "flex min-h-[6rem] flex-col border-b border-r border-white/5 p-1.5 outline-none",
                    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/50",
                    inMonth ? "bg-white/[0.015]" : "bg-transparent text-zinc-600",
                    selected && "bg-amber-500/15",
                    today_ && "ring-2 ring-inset ring-amber-400/70",
                    clickable && "cursor-pointer hover:bg-white/5"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold",
                        today_
                          ? "bg-amber-500 text-zinc-950"
                          : inMonth
                            ? "text-zinc-300"
                            : "text-zinc-600"
                      )}
                    >
                      {day.getDate()}
                    </span>
                  </div>
                  {content != null && (
                    <div className="mt-1 max-h-36 flex-1 space-y-1 overflow-y-auto">{content}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
