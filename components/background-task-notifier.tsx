"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { useToast } from "@/components/ui";

interface Cmd {
  id: number;
  name: string;
  status: string;
}

/**
 * Cross-page toast when a background "Import all" (LibraryImportBatch) finishes —
 * so you can start it and leave the Library Import page and still be notified.
 * The Library Import page shows its own completion toast, so we skip while it's
 * open to avoid a duplicate. Mounted once for admins in the app shell.
 */
export function BackgroundTaskNotifier() {
  const pathname = usePathname();
  const { data: commands } = useApi<Cmd[]>("/command");
  useEvents(); // command.updated events revalidate /command
  const toast = useToast();
  const seeded = useRef(false);
  const notified = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!commands) return;
    const done = commands.filter(
      (c) => c.name === "LibraryImportBatch" && (c.status === "completed" || c.status === "failed")
    );
    // On first load, treat already-finished batches as seen (don't toast history).
    if (!seeded.current) {
      done.forEach((c) => notified.current.add(c.id));
      seeded.current = true;
      return;
    }
    for (const c of done) {
      if (notified.current.has(c.id)) continue;
      notified.current.add(c.id);
      if (pathname === "/settings/library-import") continue; // that page toasts itself
      if (c.status === "completed") {
        toast.success("Library import finished — check Library Import for anything still unmatched.");
      } else {
        toast.error("Background library import failed — see Tasks for details.");
      }
    }
  }, [commands, pathname, toast]);

  return null;
}
