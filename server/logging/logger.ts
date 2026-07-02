import { desc, lte } from "drizzle-orm";
import { getDb, schema } from "@/server/db";

/**
 * Admin debug-log capture.
 *
 * `recordLog` persists a single row into `log_entries`; `captureConsole` mirrors
 * every `console.error`/`console.warn` into that table so the admin "Logs" page
 * can surface the app's warnings and errors. Both paths are written to *never*
 * throw and *never* recurse — logging must not be able to take the app down.
 */

type Level = "debug" | "info" | "warn" | "error";

// Keep the table bounded: after inserting, occasionally trim to the newest N rows.
const MAX_ROWS = 2000;
// Roughly 1-in-N inserts triggers a prune so we don't run a delete on every write.
const PRUNE_PROBABILITY = 0.02;

/** Coerce arbitrary context into a JSON-serialisable value (or null). */
function safeContext(context: unknown): unknown {
  if (context === undefined || context === null) return null;
  try {
    // Round-trips through JSON so anything non-serialisable (circular refs,
    // BigInt, functions, …) is dropped rather than blowing up the insert.
    return JSON.parse(JSON.stringify(context));
  } catch {
    try {
      return { value: String(context) };
    } catch {
      return null;
    }
  }
}

/** Trim `log_entries` down to the newest MAX_ROWS rows by id. */
function prune(db: ReturnType<typeof getDb>): void {
  try {
    // The (MAX_ROWS+1)-th newest row: everything at or below its id is surplus.
    const cutoff = db
      .select({ id: schema.logEntries.id })
      .from(schema.logEntries)
      .orderBy(desc(schema.logEntries.id))
      .limit(1)
      .offset(MAX_ROWS)
      .get();
    if (cutoff) {
      db.delete(schema.logEntries).where(lte(schema.logEntries.id, cutoff.id)).run();
    }
  } catch {
    // Pruning is best-effort; never let it surface.
  }
}

/**
 * Insert a log row. The whole body is guarded so a not-yet-ready DB (or any
 * other failure) can never throw into the caller.
 */
export function recordLog(
  level: Level,
  message: string,
  opts?: { source?: string; context?: unknown }
): void {
  try {
    const db = getDb();
    db.insert(schema.logEntries)
      .values({
        level,
        source: opts?.source ?? null,
        message,
        // `context` is a drizzle `mode: "json"` column, so it JSON-encodes the
        // value for us — pass the plain object, not a pre-stringified string.
        context: safeContext(opts?.context),
        createdAt: new Date(),
      })
      .run();

    if (Math.random() < PRUNE_PROBABILITY) prune(db);
  } catch {
    // Logging must never throw.
  }
}

/** Format console arguments into a message string + optional context payload. */
function formatConsoleArgs(args: unknown[]): { message: string; context?: unknown } {
  const parts: string[] = [];
  let context: unknown;

  for (const arg of args) {
    if (arg instanceof Error) {
      parts.push(arg.message);
      // Surface the stack (and any structured .cause) in the context column.
      if (context === undefined) context = { stack: arg.stack ?? null, name: arg.name };
    } else if (typeof arg === "string") {
      parts.push(arg);
    } else if (arg === null || arg === undefined) {
      parts.push(String(arg));
    } else {
      try {
        parts.push(JSON.stringify(arg));
      } catch {
        parts.push(String(arg));
      }
    }
  }

  return { message: parts.join(" "), context };
}

let installed = false;
// Re-entrancy guard: if recording a log itself triggers console.error/warn we
// must not loop back into the capture path.
let capturing = false;

/**
 * Idempotently wrap `console.error`/`console.warn` so each call is also recorded
 * into `log_entries` (source "console") before delegating to the original fn.
 */
export function captureConsole(): void {
  if (installed) return;
  installed = true;

  const original: Record<"error" | "warn", (...args: unknown[]) => void> = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
  };

  function wrap(level: "error" | "warn") {
    return (...args: unknown[]) => {
      if (!capturing) {
        capturing = true;
        try {
          const { message, context } = formatConsoleArgs(args);
          recordLog(level, message, { source: "console", context });
        } catch {
          // Never let capture failure break console output.
        } finally {
          capturing = false;
        }
      }
      original[level](...args);
    };
  }

  console.error = wrap("error");
  console.warn = wrap("warn");
}
