"use client";

import { useState } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { cn } from "@/lib/cn";
import type { CommandRow, ScheduledTask } from "@/lib/types";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  useToast,
} from "@/components/ui";

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

type ScheduleKind = "interval" | "daily" | "weekly";

/**
 * The `/system/tasks` rows now carry schedule fields that predate `ScheduledTask`
 * in lib/types. Extend locally so this page stays self-contained.
 */
type TaskRow = ScheduledTask & {
  scheduleKind: ScheduleKind;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  scheduleDay: number | null;
};

type TaskRun = {
  id: number;
  status: "queued" | "started" | "completed" | "failed";
  trigger: string;
  queuedAt: number | string;
  startedAt: number | string | null;
  endedAt: number | string | null;
  result: string | null;
  error: string | null;
};

const STATUS_TONE: Record<CommandRow["status"], BadgeTone> = {
  queued: "neutral",
  started: "warning",
  completed: "success",
  failed: "danger",
};

// Run history uses a slightly different palette per the spec (started = info).
const RUN_TONE: Record<TaskRun["status"], BadgeTone> = {
  queued: "neutral",
  started: "info",
  completed: "success",
  failed: "danger",
};

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
// Present Mon…Sun in the editor (Sun still maps to value 0 to match the backend).
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatClock(hour: number | null, minute: number | null): string {
  return `${pad2(hour ?? 0)}:${pad2(minute ?? 0)}`;
}

function formatInterval(minutes: number): string {
  if (minutes > 0 && minutes % 60 === 0) return `Every ${minutes / 60}h`;
  return `Every ${minutes}m`;
}

function formatSchedule(t: TaskRow): string {
  if (t.scheduleKind === "daily") return `Daily at ${formatClock(t.scheduleHour, t.scheduleMinute)}`;
  if (t.scheduleKind === "weekly") {
    return `Weekly on ${WEEKDAYS_SHORT[t.scheduleDay ?? 0]} at ${formatClock(t.scheduleHour, t.scheduleMinute)}`;
  }
  return formatInterval(t.intervalMinutes);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function runDuration(run: TaskRun): string {
  if (run.startedAt == null || run.endedAt == null) return "—";
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(ms) ? formatDuration(ms) : "—";
}

function deriveInterval(minutes: number): { value: number; unit: "minutes" | "hours" } {
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: "hours" };
  return { value: minutes > 0 ? minutes : 1, unit: "minutes" };
}

const COMMANDS_PAGE_SIZE = 20;
type CommandPage = { items: CommandRow[]; total: number; page: number; pageSize: number };

export default function TasksPage() {
  const [cmdPage, setCmdPage] = useState(0);
  const { data: tasks, mutate: mutateTasks } = useApi<TaskRow[]>("/system/tasks");
  const { data: cmdData, mutate: mutateCommands } = useApi<CommandPage>(
    `/command?page=${cmdPage}&pageSize=${COMMANDS_PAGE_SIZE}`,
    { keepPreviousData: true }
  );
  const commands = cmdData?.items;
  const cmdTotal = cmdData?.total ?? 0;
  const cmdPageCount = Math.max(1, Math.ceil(cmdTotal / COMMANDS_PAGE_SIZE));
  const toast = useToast();
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [viewingRuns, setViewingRuns] = useState<TaskRow | null>(null);
  useEvents();

  async function runNow(name: string) {
    setRunning((r) => ({ ...r, [name]: true }));
    try {
      await apiFetch("/command", { method: "POST", body: JSON.stringify({ name }) });
      setCmdPage(0); // jump to the newest page so the just-queued command is visible
      await Promise.all([mutateTasks(), mutateCommands()]);
      toast.success(`Queued ${name}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Failed to queue ${name}`);
    } finally {
      setRunning((r) => ({ ...r, [name]: false }));
    }
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-xl font-semibold">Tasks</h1>

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Scheduled</h2>
        {!tasks ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            title="No scheduled tasks."
            description="Background jobs will appear here once configured."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Task</TH>
                <TH>Schedule</TH>
                <TH>Next run</TH>
                <TH>Last run</TH>
                <TH>Last result</TH>
                <TH className="text-right" />
              </TR>
            </THead>
            <TBody>
              {tasks.map((t) => (
                <TR key={t.id}>
                  <TD>{t.name}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          t.enabled ? "bg-emerald-500" : "bg-zinc-600"
                        )}
                        title={t.enabled ? "Enabled" : "Disabled"}
                        aria-hidden
                      />
                      <span className={t.enabled ? "text-zinc-300" : "text-zinc-500"}>
                        {formatSchedule(t)}
                      </span>
                    </div>
                  </TD>
                  <TD className="text-zinc-400">
                    {t.enabled && t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—"}
                  </TD>
                  <TD className="text-zinc-400">
                    {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : "never"}
                  </TD>
                  <TD className="max-w-64">
                    <span
                      className="block truncate text-xs text-zinc-400"
                      title={t.lastResult ?? ""}
                    >
                      {t.lastResult ?? "—"}
                    </span>
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setViewingRuns(t)}>
                        Logs
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={!!running[t.name]}
                        onClick={() => runNow(t.name)}
                      >
                        Run now
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-300">Recent commands</h2>
          {cmdTotal > 0 && (
            <span className="text-xs text-zinc-500">{cmdTotal.toLocaleString()} total</span>
          )}
        </div>
        {!commands ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : cmdTotal === 0 ? (
          <EmptyState
            title="No commands yet."
            description="Manually triggered and scheduled commands will show up here."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Command</TH>
                  <TH>Trigger</TH>
                  <TH>Queued</TH>
                  <TH className="text-right">Status</TH>
                </TR>
              </THead>
              <TBody>
                {commands.map((c) => (
                  <TR key={c.id}>
                    <TD>{c.name}</TD>
                    <TD className="text-xs text-zinc-500">{c.trigger}</TD>
                    <TD className="text-xs text-zinc-400">
                      {new Date(c.queuedAt).toLocaleTimeString()}
                    </TD>
                    <TD className="text-right">
                      <Badge tone={STATUS_TONE[c.status]} title={c.error ?? ""}>
                        {c.status}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {cmdPageCount > 1 && (
              <div className="mt-3 flex items-center justify-between text-xs text-zinc-400">
                <span>
                  Page {cmdPage + 1} of {cmdPageCount}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cmdPage <= 0}
                    onClick={() => setCmdPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cmdPage >= cmdPageCount - 1}
                    onClick={() => setCmdPage((p) => Math.min(cmdPageCount - 1, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {editing && (
        <EditScheduleModal
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void mutateTasks()}
        />
      )}
      {viewingRuns && (
        <RunsModal task={viewingRuns} onClose={() => setViewingRuns(null)} />
      )}
    </div>
  );
}

function EditScheduleModal({
  task,
  onClose,
  onSaved,
}: {
  task: TaskRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const initInterval = deriveInterval(task.intervalMinutes);
  const [kind, setKind] = useState<ScheduleKind>(task.scheduleKind ?? "interval");
  const [intervalValue, setIntervalValue] = useState(String(initInterval.value));
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(initInterval.unit);
  const [time, setTime] = useState(formatClock(task.scheduleHour ?? 3, task.scheduleMinute ?? 0));
  const [weekday, setWeekday] = useState(task.scheduleDay ?? 1);
  const [enabled, setEnabled] = useState(task.enabled);
  const [saving, setSaving] = useState(false);

  async function save() {
    const body: Record<string, unknown> = { scheduleKind: kind, enabled };
    if (kind === "interval") {
      const n = Math.max(1, Math.round(Number(intervalValue) || 0));
      body.intervalMinutes = intervalUnit === "hours" ? n * 60 : n;
    } else {
      const [h, m] = time.split(":").map((x) => parseInt(x, 10));
      body.scheduleHour = Number.isFinite(h) ? h : 0;
      body.scheduleMinute = Number.isFinite(m) ? m : 0;
      if (kind === "weekly") body.scheduleDay = weekday;
    }

    setSaving(true);
    try {
      await apiFetch(`/system/tasks/${encodeURIComponent(task.name)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      toast.success(`Updated ${task.name}`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Failed to update ${task.name}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!saving}
      title={`Edit schedule — ${task.name}`}
      description="Choose how often this task runs."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Kind" htmlFor="sched-kind">
          <Select
            id="sched-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ScheduleKind)}
          >
            <option value="interval">Interval</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </Select>
        </Field>

        {kind === "interval" && (
          <Field label="Run every">
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={intervalValue}
                onChange={(e) => setIntervalValue(e.target.value)}
                className="w-28"
                aria-label="Interval amount"
              />
              <Select
                value={intervalUnit}
                onChange={(e) => setIntervalUnit(e.target.value as "minutes" | "hours")}
                aria-label="Interval unit"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </Select>
            </div>
          </Field>
        )}

        {kind === "weekly" && (
          <Field label="Day" htmlFor="sched-day">
            <Select
              id="sched-day"
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEKDAY_ORDER.map((d) => (
                <option key={d} value={d}>
                  {WEEKDAYS_LONG[d]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {(kind === "daily" || kind === "weekly") && (
          <Field label="Time" htmlFor="sched-time">
            <Input
              id="sched-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
        )}

        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
    </Modal>
  );
}

function RunsModal({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const { data: runs } = useApi<TaskRun[]>(`/system/tasks/${encodeURIComponent(task.name)}/runs`);

  return (
    <Modal open onClose={onClose} size="lg" title={`Run history — ${task.name}`}>
      {!runs ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          title="No runs yet."
          description="This task hasn't run. Trigger it with Run now to see history here."
        />
      ) : (
        <ul className="space-y-3">
          {runs.map((run) => (
            <li
              key={run.id}
              className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <Badge tone={RUN_TONE[run.status] ?? "neutral"}>{run.status}</Badge>
                <span className="text-zinc-400">{new Date(run.queuedAt).toLocaleString()}</span>
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-500">{run.trigger}</span>
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-500">{runDuration(run)}</span>
              </div>
              {(run.error ?? run.result) != null && (run.error ?? run.result) !== "" && (
                <pre
                  className={cn(
                    "mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-900 p-2 font-mono text-xs",
                    run.error ? "text-red-300" : "text-zinc-400"
                  )}
                >
                  {run.error ?? run.result}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
