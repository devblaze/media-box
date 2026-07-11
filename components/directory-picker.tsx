"use client";

import { useState } from "react";
import { useApi } from "@/lib/api";
import { Button, Modal, Spinner } from "@/components/ui";

export interface FsListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
}

// Modal filesystem browser powering "browse for a folder" pickers across the app
// (root folders, download-client staging dirs, …). Backed by GET /api/v1/fs.
export function DirectoryPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState("/");
  const { data } = useApi<FsListing>(`/fs?path=${encodeURIComponent(current)}`);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title="Choose a folder"
      dismissable={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              setBusy(true);
              try {
                await onPick(data?.path ?? current);
              } finally {
                setBusy(false);
              }
            }}
            loading={busy}
            disabled={busy || !data}
          >
            Use this folder
          </Button>
        </>
      }
    >
      <div className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs">
        {data?.path ?? current}
      </div>
      <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-md border border-zinc-800">
        {data?.parent !== null && data?.parent !== undefined && (
          <button
            onClick={() => setCurrent(data.parent!)}
            className="block w-full px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-800"
          >
            ..
          </button>
        )}
        {(data?.directories ?? []).map((d) => (
          <button
            key={d.path}
            onClick={() => setCurrent(d.path)}
            className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-zinc-800"
          >
            {d.name}
          </button>
        ))}
        {!data && (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-500">
            <Spinner className="size-4" /> Loading…
          </div>
        )}
      </div>
    </Modal>
  );
}
