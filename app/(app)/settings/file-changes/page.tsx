"use client";

import { useState, type ComponentProps } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { timeAgo } from "@/lib/types";
import { principalHasPermission } from "@/lib/permissions";
import {
  Badge,
  Button,
  EmptyState,
  Modal,
  Skeleton,
  useToast,
} from "@/components/ui";

type Kind = "import" | "organize" | "deleteMovie" | "deleteSeries" | "deleteVersion";
type Status = "pending" | "approved" | "declined" | "applied" | "failed";

interface FileChange {
  id: number;
  kind: Kind;
  status: Status;
  title: string;
  detail: string | null;
  error: string | null;
  createdAt: number | string;
  decidedAt: number | string | null;
}

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
  permissions?: string[];
}

const KIND_LABEL: Record<Kind, string> = {
  import: "Import",
  organize: "Organize",
  deleteMovie: "Delete movie",
  deleteSeries: "Delete series",
  deleteVersion: "Delete version",
};

const STATUS_META: Record<Status, { label: string; tone: ComponentProps<typeof Badge>["tone"] }> = {
  pending: { label: "Pending", tone: "accent" },
  approved: { label: "Approved", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
};

function toMillis(value: number | string): number {
  return typeof value === "number" ? value : Date.parse(value);
}

export default function FileChangesPage() {
  const { data: me } = useApi<Me>("/auth/me");
  const { data: changes, mutate } = useApi<FileChange[]>("/file-changes");
  const [deciding, setDeciding] = useState<number | null>(null);
  const [viewing, setViewing] = useState<FileChange | null>(null);
  const toast = useToast();
  useEvents();

  const canApprove = principalHasPermission(me, "files.approve");

  async function decide(id: number, action: "approve" | "decline") {
    setDeciding(id);
    try {
      const res = await apiFetch<{ status?: string; error?: string | null }>(`/file-changes/${id}`, {
        method: "PUT",
        body: JSON.stringify({ action }),
      });
      await mutate();
      if (action === "decline") {
        toast.success("Change declined");
      } else if (res.status === "failed") {
        toast.error(res.error || "Applying the change failed");
      } else {
        toast.success("Change approved and applied");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `${action} failed`);
    } finally {
      setDeciding(null);
    }
  }

  if (me && !canApprove) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-xl font-semibold">File Changes</h1>
        <EmptyState
          className="mt-4"
          title="No access"
          description="You need the “Approve file changes” permission to review held file changes."
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">File Changes</h1>
      <p className="text-sm text-zinc-400">
        When file operations are set to <strong>Ask</strong> (Settings → Media Management), imports,
        organizing, and with-files deletes are held here until you approve or decline them. Approving
        performs the real file operation.
      </p>

      {!changes ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : changes.length === 0 ? (
        <EmptyState
          title="No file changes"
          description="Held file changes will appear here while file operations are in Ask mode."
        />
      ) : (
        <div className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800">
          {changes.map((c) => {
            const status = STATUS_META[c.status] ?? STATUS_META.pending;
            return (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-900/40">
                {/* Name + path: flexes and truncates so the row never overflows.
                    Click to see the full name in a dialog. */}
                <button
                  type="button"
                  onClick={() => setViewing(c)}
                  className="min-w-0 flex-1 text-left"
                  title="View full name"
                >
                  <div className="truncate font-medium text-zinc-100">{c.title}</div>
                  {c.detail ? (
                    <div className="truncate font-mono text-xs text-zinc-500">{c.detail}</div>
                  ) : null}
                  {c.status === "failed" && c.error ? (
                    <div className="truncate text-xs text-red-400">{c.error}</div>
                  ) : null}
                </button>

                {/* Meta + actions: fixed on the right, always visible (no scrolling). */}
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone="neutral" className="hidden sm:inline-flex">
                    {KIND_LABEL[c.kind] ?? c.kind}
                  </Badge>
                  <Badge tone={status.tone} title={c.error ?? undefined}>
                    {status.label}
                  </Badge>
                  <span className="hidden whitespace-nowrap text-xs text-zinc-500 md:inline">
                    {timeAgo(toMillis(c.createdAt))}
                  </span>
                  {c.status === "pending" && (
                    <>
                      <Button
                        size="sm"
                        loading={deciding === c.id}
                        disabled={deciding !== null}
                        onClick={() => decide(c.id, "approve")}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deciding !== null}
                        onClick={() => decide(c.id, "decline")}
                      >
                        Decline
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title="File change"
        footer={
          <Button variant="secondary" size="sm" onClick={() => setViewing(null)}>
            Close
          </Button>
        }
      >
        {viewing && (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Change</div>
              <div className="mt-1 break-all text-sm text-zinc-100">{viewing.title}</div>
            </div>
            {viewing.detail && (
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Path</div>
                <div className="mt-1 break-all font-mono text-xs text-zinc-300">
                  {viewing.detail}
                </div>
              </div>
            )}
            {viewing.error && (
              <div className="break-all text-sm text-red-400">{viewing.error}</div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
