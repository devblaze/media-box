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
  Skeleton,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
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
        <Table>
          <THead>
            <TR>
              <TH>Change</TH>
              <TH className="w-32">Type</TH>
              <TH className="w-28">Status</TH>
              <TH className="w-28">Created</TH>
              <TH className="w-48 text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {changes.map((c) => {
              const status = STATUS_META[c.status] ?? STATUS_META.pending;
              return (
                <TR key={c.id} className="align-middle">
                  <TD>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-zinc-100">{c.title}</div>
                      {c.detail ? (
                        <div className="truncate font-mono text-xs text-zinc-500">{c.detail}</div>
                      ) : null}
                      {c.status === "failed" && c.error ? (
                        <div className="mt-0.5 truncate text-xs text-red-400">{c.error}</div>
                      ) : null}
                    </div>
                  </TD>
                  <TD>
                    <Badge tone="neutral">{KIND_LABEL[c.kind] ?? c.kind}</Badge>
                  </TD>
                  <TD>
                    <Badge tone={status.tone} title={c.error ?? undefined}>
                      {status.label}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-zinc-500">
                    {timeAgo(toMillis(c.createdAt))}
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-2">
                      {c.status === "pending" ? (
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
                      ) : (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
