import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { emitEvent } from "@/server/events/bus";

export type CommandHandler = (payload: unknown) => Promise<string | void>;

interface HandlerDef {
  handler: CommandHandler;
  // Commands in the same parallel group can run alongside the main lane.
  // 'main' commands run one at a time.
  lane: "main" | "monitor";
}

// Lives on globalThis so dev HMR module reloads register into the same map
// the running tick loop reads from.
const HANDLERS_KEY = Symbol.for("mediabox.handlers");
type GlobalWithHandlers = typeof globalThis & { [HANDLERS_KEY]?: Map<string, HandlerDef> };

function getHandlers(): Map<string, HandlerDef> {
  const g = globalThis as GlobalWithHandlers;
  if (!g[HANDLERS_KEY]) g[HANDLERS_KEY] = new Map();
  return g[HANDLERS_KEY];
}

const handlers = getHandlers();

export function registerHandler(
  name: string,
  handler: CommandHandler,
  lane: "main" | "monitor" = "main"
) {
  handlers.set(name, { handler, lane });
}

export interface ScheduledTaskDef {
  name: string;
  intervalMinutes: number;
}

export const SCHEDULED_TASKS: ScheduledTaskDef[] = [
  { name: "RssSync", intervalMinutes: 15 },
  { name: "WantedSearch", intervalMinutes: 1440 },
  { name: "SubtitleSearch", intervalMinutes: 1440 },
  { name: "QueueMonitor", intervalMinutes: 1 },
  { name: "RefreshSeries", intervalMinutes: 720 },
  { name: "RefreshMovies", intervalMinutes: 720 },
  { name: "DiskScan", intervalMinutes: 720 },
  { name: "Housekeeping", intervalMinutes: 1440 },
];

const MONITOR_COMMANDS = new Set(["QueueMonitor"]);

export function enqueueCommand(
  name: string,
  payload: unknown = null,
  trigger: "scheduled" | "manual" | "system" = "system",
  priority = 0
): number | null {
  const db = getDb();
  // suppress duplicates: same name+payload already waiting or running
  const payloadJson = payload === null ? null : JSON.stringify(payload);
  const existing = db
    .select({ id: schema.commands.id, payload: schema.commands.payload })
    .from(schema.commands)
    .where(and(inArray(schema.commands.status, ["queued", "started"]), eq(schema.commands.name, name)))
    .all();
  if (existing.some((c) => JSON.stringify(c.payload ?? null) === (payloadJson ?? "null"))) {
    return null;
  }
  const row = db
    .insert(schema.commands)
    .values({ name, payload, trigger, priority, queuedAt: new Date(), status: "queued" })
    .returning({ id: schema.commands.id })
    .get();
  emitEvent({ type: "command.updated", commandId: row.id, name, status: "queued" });
  return row.id;
}

function claimNext(lane: "main" | "monitor"): { id: number; name: string; payload: unknown } | null {
  const db = getDb();
  const candidates = db
    .select()
    .from(schema.commands)
    .where(eq(schema.commands.status, "queued"))
    .orderBy(sql`${schema.commands.priority} DESC`, asc(schema.commands.queuedAt))
    .all();
  const next = candidates.find((c) =>
    lane === "monitor" ? MONITOR_COMMANDS.has(c.name) : !MONITOR_COMMANDS.has(c.name)
  );
  if (!next) return null;
  db.update(schema.commands)
    .set({ status: "started", startedAt: new Date() })
    .where(eq(schema.commands.id, next.id))
    .run();
  return { id: next.id, name: next.name, payload: next.payload };
}

async function runCommand(cmd: { id: number; name: string; payload: unknown }) {
  const db = getDb();
  const def = handlers.get(cmd.name);
  emitEvent({ type: "command.updated", commandId: cmd.id, name: cmd.name, status: "started" });
  const started = Date.now();
  try {
    if (!def) throw new Error(`No handler registered for command '${cmd.name}'`);
    const result = await def.handler(cmd.payload);
    db.update(schema.commands)
      .set({ status: "completed", endedAt: new Date(), result: result ?? "ok" })
      .where(eq(schema.commands.id, cmd.id))
      .run();
    db.update(schema.scheduledTasks)
      .set({
        lastRunAt: new Date(),
        lastDurationMs: Date.now() - started,
        lastResult: result ?? "ok",
      })
      .where(eq(schema.scheduledTasks.name, cmd.name))
      .run();
    emitEvent({ type: "command.updated", commandId: cmd.id, name: cmd.name, status: "completed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] command ${cmd.name}#${cmd.id} failed:`, err);
    db.update(schema.commands)
      .set({ status: "failed", endedAt: new Date(), error: message })
      .where(eq(schema.commands.id, cmd.id))
      .run();
    db.update(schema.scheduledTasks)
      .set({ lastRunAt: new Date(), lastDurationMs: Date.now() - started, lastResult: `failed: ${message}` })
      .where(eq(schema.scheduledTasks.name, cmd.name))
      .run();
    emitEvent({ type: "command.updated", commandId: cmd.id, name: cmd.name, status: "failed" });
  }
}

export interface Schedulable {
  scheduleKind: "interval" | "daily" | "weekly";
  intervalMinutes: number;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  scheduleDay: number | null;
}

/** Next fire time for a task given its schedule (interval / daily / weekly), in server local time. */
export function computeNextRun(task: Schedulable, from: Date): Date {
  if (task.scheduleKind === "daily" || task.scheduleKind === "weekly") {
    const next = new Date(from);
    next.setHours(task.scheduleHour ?? 3, task.scheduleMinute ?? 0, 0, 0);
    if (task.scheduleKind === "weekly") {
      const targetDay = task.scheduleDay ?? 1; // Monday default
      let addDays = (targetDay - next.getDay() + 7) % 7;
      if (addDays === 0 && next <= from) addDays = 7;
      next.setDate(next.getDate() + addDays);
    } else if (next <= from) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
  return new Date(from.getTime() + Math.max(1, task.intervalMinutes) * 60_000);
}

function enqueueDueTasks() {
  const db = getDb();
  const now = new Date();
  const due = db
    .select()
    .from(schema.scheduledTasks)
    .where(and(eq(schema.scheduledTasks.enabled, true), lt(schema.scheduledTasks.nextRunAt, now)))
    .all();
  for (const task of due) {
    enqueueCommand(task.name, null, "scheduled");
    db.update(schema.scheduledTasks)
      .set({ nextRunAt: computeNextRun(task, now) })
      .where(eq(schema.scheduledTasks.id, task.id))
      .run();
  }
}

const busy: Record<"main" | "monitor", boolean> = { main: false, monitor: false };

async function pump(lane: "main" | "monitor") {
  if (busy[lane]) return;
  busy[lane] = true;
  try {
    let cmd = claimNext(lane);
    while (cmd) {
      await runCommand(cmd);
      cmd = claimNext(lane);
    }
  } finally {
    busy[lane] = false;
  }
}

export function recoverInterruptedCommands() {
  const db = getDb();
  db.update(schema.commands)
    .set({ status: "failed", endedAt: new Date(), error: "interrupted by restart" })
    .where(eq(schema.commands.status, "started"))
    .run();
}

export function startScheduler() {
  const tick = () => {
    try {
      enqueueDueTasks();
      void pump("main");
      void pump("monitor");
    } catch (err) {
      console.error("[scheduler] tick failed:", err);
    }
  };
  const interval = setInterval(tick, 10_000);
  interval.unref();
  tick();
  console.log("[boot] scheduler started");
}
