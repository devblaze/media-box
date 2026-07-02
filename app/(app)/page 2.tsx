"use client";

import { useApi } from "@/lib/api";

interface SystemStatus {
  appName: string;
  version: string;
  startedAt: string;
  configDir: string;
  node: string;
}

export default function DashboardPage() {
  const { data } = useApi<SystemStatus>("/system/status");
  return (
    <div>
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="mt-4 grid max-w-md gap-2 text-sm text-zinc-300">
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="font-medium text-zinc-100">System</div>
          {data ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-zinc-500">Version</dt>
              <dd>{data.version}</dd>
              <dt className="text-zinc-500">Started</dt>
              <dd>{new Date(data.startedAt).toLocaleString()}</dd>
              <dt className="text-zinc-500">Config</dt>
              <dd className="font-mono text-xs">{data.configDir}</dd>
              <dt className="text-zinc-500">Node</dt>
              <dd>{data.node}</dd>
            </dl>
          ) : (
            <p className="mt-2 text-zinc-500">Loading…</p>
          )}
        </div>
      </div>
    </div>
  );
}
