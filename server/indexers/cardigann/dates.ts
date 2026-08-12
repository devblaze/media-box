/**
 * Best-effort date parsing for Cardigann's `dateparse`/`timeparse` and
 * `fuzzytime`/`timeago` filters. Prowlarr uses C# format strings ("MMM. d yy"),
 * older Jackett-era defs use Go reference layouts ("2006-01-02"). We normalize
 * both into a token list and fill in what we can; anything unparseable falls
 * back to `Date.parse`, and callers treat failure as "no date" rather than a
 * hard error — a missing pubDate is not worth dropping a result over.
 */

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndex(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  const idx = MONTHS.findIndex((m) => m === n || m.slice(0, 3) === n.slice(0, 3));
  return idx;
}

interface DateParts {
  year?: number;
  month?: number; // 1-12
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  /** Undefined when the layout has no AM/PM token; false means explicit AM. */
  pm?: boolean;
}

/** C#-style format tokens, longest first so "MMMM" wins over "MM". */
const CSHARP_TOKENS: { token: string; pattern: string; apply: (p: DateParts, v: string) => void }[] = [
  { token: "yyyy", pattern: "(\\d{4})", apply: (p, v) => (p.year = Number(v)) },
  { token: "yy", pattern: "(\\d{2})", apply: (p, v) => (p.year = 2000 + Number(v)) },
  { token: "MMMM", pattern: "([A-Za-z]+\\.?)", apply: (p, v) => (p.month = monthIndex(v) + 1) },
  { token: "MMM", pattern: "([A-Za-z]+\\.?)", apply: (p, v) => (p.month = monthIndex(v) + 1) },
  { token: "MM", pattern: "(\\d{2})", apply: (p, v) => (p.month = Number(v)) },
  { token: "M", pattern: "(\\d{1,2})", apply: (p, v) => (p.month = Number(v)) },
  { token: "dd", pattern: "(\\d{2})", apply: (p, v) => (p.day = Number(v)) },
  { token: "d", pattern: "(\\d{1,2})", apply: (p, v) => (p.day = Number(v)) },
  { token: "HH", pattern: "(\\d{2})", apply: (p, v) => (p.hour = Number(v)) },
  { token: "H", pattern: "(\\d{1,2})", apply: (p, v) => (p.hour = Number(v)) },
  { token: "hh", pattern: "(\\d{2})", apply: (p, v) => (p.hour = Number(v)) },
  { token: "h", pattern: "(\\d{1,2})", apply: (p, v) => (p.hour = Number(v)) },
  { token: "mm", pattern: "(\\d{2})", apply: (p, v) => (p.minute = Number(v)) },
  { token: "m", pattern: "(\\d{1,2})", apply: (p, v) => (p.minute = Number(v)) },
  { token: "ss", pattern: "(\\d{2})", apply: (p, v) => (p.second = Number(v)) },
  { token: "s", pattern: "(\\d{1,2})", apply: (p, v) => (p.second = Number(v)) },
  { token: "tt", pattern: "([AaPp][Mm])", apply: (p, v) => (p.pm = /p/i.test(v)) },
  { token: "t", pattern: "([AaPp][Mm]?)", apply: (p, v) => (p.pm = /p/i.test(v)) },
];

/** Go reference-date tokens ("Mon Jan 2 15:04:05 MST 2006") → same machinery. */
const GO_TOKENS: Record<string, { pattern: string; apply: (p: DateParts, v: string) => void }> = {
  "2006": { pattern: "(\\d{4})", apply: (p, v) => (p.year = Number(v)) },
  "06": { pattern: "(\\d{2})", apply: (p, v) => (p.year = 2000 + Number(v)) },
  January: { pattern: "([A-Za-z]+)", apply: (p, v) => (p.month = monthIndex(v) + 1) },
  Jan: { pattern: "([A-Za-z]+\\.?)", apply: (p, v) => (p.month = monthIndex(v) + 1) },
  "01": { pattern: "(\\d{2})", apply: (p, v) => (p.month = Number(v)) },
  "1": { pattern: "(\\d{1,2})", apply: (p, v) => (p.month = Number(v)) },
  "02": { pattern: "(\\d{2})", apply: (p, v) => (p.day = Number(v)) },
  _2: { pattern: "\\s?(\\d{1,2})", apply: (p, v) => (p.day = Number(v)) },
  "2": { pattern: "(\\d{1,2})", apply: (p, v) => (p.day = Number(v)) },
  "15": { pattern: "(\\d{1,2})", apply: (p, v) => (p.hour = Number(v)) },
  "03": { pattern: "(\\d{2})", apply: (p, v) => (p.hour = Number(v)) },
  "3": { pattern: "(\\d{1,2})", apply: (p, v) => (p.hour = Number(v)) },
  "04": { pattern: "(\\d{2})", apply: (p, v) => (p.minute = Number(v)) },
  "4": { pattern: "(\\d{1,2})", apply: (p, v) => (p.minute = Number(v)) },
  "05": { pattern: "(\\d{2})", apply: (p, v) => (p.second = Number(v)) },
  "5": { pattern: "(\\d{1,2})", apply: (p, v) => (p.second = Number(v)) },
  PM: { pattern: "([AP]M)", apply: (p, v) => (p.pm = v.startsWith("P")) },
  pm: { pattern: "([ap]m)", apply: (p, v) => (p.pm = v.startsWith("p")) },
  Mon: { pattern: "([A-Za-z]{3})", apply: () => undefined },
  Monday: { pattern: "([A-Za-z]+)", apply: () => undefined },
  MST: { pattern: "([A-Z]{2,5})", apply: () => undefined },
  "-0700": { pattern: "([+-]\\d{4})", apply: () => undefined },
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does the layout look like a Go reference layout ("2006-01-02 15:04") rather
 * than C# tokens ("yyyy-MM-dd HH:mm")? The Go magic numbers and the literal
 * month name "Jan" never appear in C# layouts, which use letter runs instead.
 */
function looksLikeGoLayout(layout: string): boolean {
  return /2006|15:04|Jan|Monday|Mon\b/.test(layout);
}

function compile(layout: string, go: boolean): { re: RegExp; appliers: ((p: DateParts, v: string) => void)[] } {
  let pattern = "";
  const appliers: ((p: DateParts, v: string) => void)[] = [];
  let i = 0;
  outer: while (i < layout.length) {
    if (go) {
      // Longest-match against Go tokens.
      const keys = Object.keys(GO_TOKENS).sort((a, b) => b.length - a.length);
      for (const key of keys) {
        if (layout.startsWith(key, i)) {
          pattern += GO_TOKENS[key].pattern;
          appliers.push(GO_TOKENS[key].apply);
          i += key.length;
          continue outer;
        }
      }
    } else {
      for (const t of CSHARP_TOKENS) {
        if (layout.startsWith(t.token, i)) {
          pattern += t.pattern;
          appliers.push(t.apply);
          i += t.token.length;
          continue outer;
        }
      }
    }
    const ch = layout[i];
    // Literal separators are matched loosely: any run of spaces matches "\s+".
    pattern += ch === " " ? "\\s+" : escapeRe(ch);
    i++;
  }
  return { re: new RegExp(`^\\s*${pattern}\\s*$`), appliers };
}

/** Parse `value` with a C# or Go date layout. Returns null when it won't fit. */
export function parseWithLayout(value: string, layout: string): Date | null {
  try {
    const { re, appliers } = compile(layout, looksLikeGoLayout(layout));
    const m = re.exec(value);
    if (!m) return null;
    const parts: DateParts = {};
    appliers.forEach((apply, idx) => apply(parts, m[idx + 1] ?? ""));
    if (parts.month !== undefined && (parts.month < 1 || parts.month > 12)) return null;
    const now = new Date();
    let hour = parts.hour ?? 0;
    if (parts.pm && hour < 12) hour += 12;
    if (parts.pm === false && hour === 12) hour = 0;
    const d = new Date(
      Date.UTC(
        parts.year ?? now.getUTCFullYear(),
        (parts.month ?? 1) - 1,
        parts.day ?? 1,
        hour,
        parts.minute ?? 0,
        parts.second ?? 0
      )
    );
    // Layouts without a year mean "this year" — but never the future (a
    // December date scraped in January belongs to last year).
    if (parts.year === undefined && d.getTime() > now.getTime() + 24 * 3600 * 1000) {
      d.setUTCFullYear(d.getUTCFullYear() - 1);
    }
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

const UNIT_MS: Record<string, number> = {
  sec: 1000,
  second: 1000,
  min: 60_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/**
 * Parse human-relative timestamps sites love: "3 months ago", "yesterday",
 * "Today 12:45", "12:25am", "now". Mirrors Jackett's DateTimeUtil fuzzy path.
 */
export function parseFuzzyDate(raw: string): Date | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const now = new Date();
  if (value === "now" || value === "just now" || value === "today") return now;
  if (value === "yesterday") return new Date(now.getTime() - 86_400_000);

  // "<n> <unit>(s) ago" or bare "<n> <unit>" (some sites drop the "ago").
  const rel = /^(\d+(?:\.\d+)?)\s*(sec|second|min|minute|hour|day|week|month|year)s?(?:\s+ago)?$/.exec(value);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * UNIT_MS[rel[2]]);

  // Clock-only values mean "today at that time": "12:25am", "18:04".
  const clock = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(value);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[3] === "pm" && hour < 12) hour += 12;
    if (clock[3] === "am" && hour === 12) hour = 0;
    const d = new Date(now);
    d.setHours(hour, Number(clock[2]), 0, 0);
    if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
    return d;
  }

  // "today 12:45" / "yesterday 08:15"
  const dayClock = /^(today|yesterday)\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(value);
  if (dayClock) {
    let hour = Number(dayClock[2]);
    if (dayClock[4] === "pm" && hour < 12) hour += 12;
    if (dayClock[4] === "am" && hour === 12) hour = 0;
    const d = new Date(now);
    if (dayClock[1] === "yesterday") d.setDate(d.getDate() - 1);
    d.setHours(hour, Number(dayClock[3]), 0, 0);
    return d;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
