"use client";

import { useState } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import type { CommandRow, ScheduledTask } from "@/lib/types";
import {
  Badge,
  Button,
  EmptyState,
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

const STATUS_TONE: Record<CommandRow["status"], BadgeTone> = {
  queued: "neutral",
  started: "warning",
  completed: "success",
  failed: "danger",
};

export default function TasksPage() {
  const { data: tasks, mutate: mutateTasks } = useApi<ScheduledTask[]>("/system/tasks");
  const { data: commands, mutate: mutateCommands } = useApi<CommandRow[]>("/command");
  const toast = useToast();
  const [running, setRunning] = useState<Record<string, boolean>>({});
  useEvents();

  async function runNow(name: string) {
    setRunning((r) => ({ ...r, [name]: true }));
    try {
      await apiFetch("/command", { method: "POST", body: JSON.stringify({ name }) });
      await Promise.all([mutateTasks(), mutateCommands()]);
      toast.success(`Queued ${name}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Failed to queue ${name}`);
    } finally {
      setRunning((r) => ({ ...r, [name]: false }));
    }
  }

  return (
    <div className="max-w-4xl">
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
                <TH>Interval</TH>
                <TH>Last run</TH>
                <TH>Last result</TH>
                <TH className="text-right" />
              </TR>
            </THead>
            <TBody>
              {tasks.map((t) => (
                <TR key={t.id}>
                  <TD>{t.name}</TD>
                  <TD className="text-zinc-400">
                    {t.intervalMinutes >= 60 ? `${t.intervalMinutes / 60}h` : `${t.intervalMinutes}m`}
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
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={!!running[t.name]}
                      onClick={() => runNow(t.name)}
                    >
                      Run now
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Recent commands</h2>
        {!commands ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : commands.length === 0 ? (
          <EmptyState
            title="No commands yet."
            description="Manually triggered and scheduled commands will show up here."
          />
        ) : (
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
        )}
      </section>
    </div>
  );
}
