"use client";

import { Fragment, useState } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import {
  Badge,
  Button,
  EmptyState,
  Modal,
  Select,
  Skeleton,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  useConfirm,
  useToast,
} from "@/components/ui";

type Level = "debug" | "info" | "warn" | "error";
type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

interface LogEntry {
  id: number;
  level: Level;
  source: string | null;
  message: string;
  context: unknown;
  createdAt: number | string;
}

const LEVEL_TONE: Record<Level, BadgeTone> = {
  error: "danger", // red
  warn: "warning", // amber/yellow
  info: "info", // sky/zinc
  debug: "neutral", // muted
};

const LEVEL_FILTERS = ["all", "error", "warn", "info", "debug"] as const;
type LevelFilter = (typeof LEVEL_FILTERS)[number];

const LIMIT = 500;

export default function LogsPage() {
  const [level, setLevel] = useState<LevelFilter>("all");
  const query =
    level === "all" ? `/logs?limit=${LIMIT}` : `/logs?level=${level}&limit=${LIMIT}`;
  const { data: logs, mutate, isLoading } = useApi<LogEntry[]>(query);
  const { data: settings } = useApi<{ aiProvider: "none" | "ollama" | "openrouter" }>("/settings");
  const toast = useToast();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await mutate();
    } finally {
      setRefreshing(false);
    }
  }

  async function clearLogs() {
    if (
      !(await confirm({
        message: "Clear all captured log entries? This cannot be undone.",
        danger: true,
      }))
    )
      return;
    setClearing(true);
    try {
      await apiFetch("/logs", { method: "DELETE" });
      setExpanded(new Set());
      await mutate();
      toast.success("Logs cleared");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to clear logs");
    } finally {
      setClearing(false);
    }
  }

  async function diagnose() {
    setDiagnosing(true);
    try {
      const { answer } = await apiFetch<{ answer: string }>("/ai/diagnose", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setDiagnosis(answer);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "AI diagnosis failed");
    } finally {
      setDiagnosing(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Logs</h1>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Select
            aria-label="Filter by level"
            value={level}
            onChange={(e) => setLevel(e.target.value as LevelFilter)}
            className="w-full sm:w-32"
          >
            <option value="all">All levels</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </Select>
          {settings && settings.aiProvider !== "none" && (
            <Button variant="secondary" size="sm" onClick={diagnose} loading={diagnosing}>
              {diagnosing ? "Diagnosing…" : "Diagnose with AI"}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={refresh} loading={refreshing}>
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-300"
            onClick={clearLogs}
            loading={clearing}
            disabled={clearing || !logs || logs.length === 0}
          >
            Clear logs
          </Button>
        </div>
      </div>

      <p className="text-sm text-zinc-400">
        Captured warnings and errors from the running app. Click a row to inspect its context.
      </p>

      {isLoading && !logs ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : !logs || logs.length === 0 ? (
        <EmptyState
          title="No log entries"
          description="Warnings and errors raised by the app will appear here."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-44">Time</TH>
              <TH className="w-20">Level</TH>
              <TH className="w-28">Source</TH>
              <TH>Message</TH>
            </TR>
          </THead>
          <TBody>
            {logs.map((entry) => {
              const isOpen = expanded.has(entry.id);
              const hasContext = entry.context !== null && entry.context !== undefined;
              return (
                <Fragment key={entry.id}>
                  <TR
                    className="cursor-pointer align-top"
                    onClick={() => toggle(entry.id)}
                  >
                    <TD className="whitespace-nowrap text-xs text-zinc-400">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TD>
                    <TD>
                      <Badge tone={LEVEL_TONE[entry.level]}>{entry.level}</Badge>
                    </TD>
                    <TD className="text-xs text-zinc-500">{entry.source ?? "—"}</TD>
                    <TD className="text-zinc-200">
                      <div className="flex items-start gap-2">
                        <span
                          aria-hidden
                          className="mt-0.5 select-none text-zinc-600"
                        >
                          {hasContext ? (isOpen ? "▾" : "▸") : "•"}
                        </span>
                        <span className="min-w-0 break-words">{entry.message}</span>
                      </div>
                    </TD>
                  </TR>
                  {isOpen && (
                    <TR className="bg-zinc-900/40">
                      <TD colSpan={4}>
                        {hasContext ? (
                          <pre className="overflow-x-auto rounded bg-black/40 p-3 text-xs text-zinc-300">
                            {safeStringify(entry.context)}
                          </pre>
                        ) : (
                          <span className="text-xs text-zinc-500">No context recorded.</span>
                        )}
                      </TD>
                    </TR>
                  )}
                </Fragment>
              );
            })}
          </TBody>
        </Table>
      )}

      <Modal
        open={diagnosis !== null}
        onClose={() => setDiagnosis(null)}
        title="AI diagnosis"
        description="Generated from the app version, sanitized settings, recent warnings/errors, and download state."
        size="lg"
        footer={
          <Button variant="secondary" size="sm" onClick={() => setDiagnosis(null)}>
            Close
          </Button>
        }
      >
        <div className="whitespace-pre-wrap text-sm text-zinc-200">{diagnosis}</div>
      </Modal>
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
