"use client";

import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import type { QualityProfile } from "@/lib/types";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  HowTo,
  Input,
  Modal,
  Select,
  Skeleton,
  Switch,
  useConfirm,
  useToast,
} from "@/components/ui";

interface QualityDefinition {
  id: number;
  name: string;
  rank: number;
}

export default function ProfilesPage() {
  const { data: profiles, mutate } = useApi<QualityProfile[]>("/qualityprofiles");
  const { data: qualities } = useApi<QualityDefinition[]>("/qualitydefinitions");
  const [editing, setEditing] = useState<Partial<QualityProfile> | null>(null);

  if (!qualities) {
    return (
      <div className="max-w-3xl space-y-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const defs = qualities;
  function addProfile() {
    setEditing({
      name: "",
      upgradeAllowed: true,
      cutoffQualityId: defs.find((q) => q.id !== 0)?.id ?? 7,
      items: defs.filter((q) => q.id !== 0).map((q) => ({ qualityId: q.id, allowed: false })),
    });
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Quality Profiles</h1>
        <Button onClick={addProfile}>Add profile</Button>
      </div>

      <HowTo title="How quality profiles work">
        <p>A quality profile decides which releases media-box grabs and when it stops looking.</p>
        <ul>
          <li>
            <strong>Allowed qualities</strong> — tick every quality you accept. Releases in an
            unticked quality are ignored.
          </li>
          <li>
            <strong>Cutoff</strong> — the target quality. Once a file reaches the cutoff, media-box
            stops searching for anything better.
          </li>
          <li>
            <strong>Upgrades</strong> — when enabled, media-box replaces an existing file with a
            higher allowed quality until the cutoff is met.
          </li>
        </ul>
      </HowTo>

      {profiles === undefined ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : profiles.length === 0 ? (
        <EmptyState
          title="No quality profiles yet"
          description="Profiles tell media-box which qualities to download and when to stop upgrading."
          action={<Button onClick={addProfile}>Add profile</Button>}
        />
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => {
            const allowedCount = p.items.filter((i) => i.allowed).length;
            const cutoffName = qualities.find((q) => q.id === p.cutoffQualityId)?.name ?? "?";
            return (
              <button
                key={p.id}
                onClick={() => setEditing(p)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:border-amber-500/60"
              >
                <span className="font-medium">{p.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone="neutral">{allowedCount} qualities</Badge>
                  <Badge tone="accent">cutoff {cutoffName}</Badge>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {editing && (
        <ProfileDialog
          initial={editing}
          qualities={qualities}
          onClose={() => setEditing(null)}
          onChanged={async () => {
            setEditing(null);
            await mutate();
          }}
        />
      )}
    </div>
  );
}

function ProfileDialog({
  initial,
  qualities,
  onClose,
  onChanged,
}: {
  initial: Partial<QualityProfile>;
  qualities: QualityDefinition[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const isNew = initial.id === undefined;
  const [name, setName] = useState(initial.name ?? "");
  const [upgradeAllowed, setUpgradeAllowed] = useState(initial.upgradeAllowed ?? true);
  const [cutoffQualityId, setCutoffQualityId] = useState(initial.cutoffQualityId ?? 7);
  const [items, setItems] = useState(initial.items ?? []);
  const [busy, setBusy] = useState(false);

  function toggle(qualityId: number) {
    setItems((prev) =>
      prev.map((i) => (i.qualityId === qualityId ? { ...i, allowed: !i.allowed } : i))
    );
  }

  const allowed = items.filter((i) => i.allowed);

  async function save() {
    setBusy(true);
    try {
      const body = { name, upgradeAllowed, cutoffQualityId, items };
      if (isNew) {
        await apiFetch("/qualityprofiles", { method: "POST", body: JSON.stringify(body) });
      } else {
        await apiFetch(`/qualityprofiles/${initial.id}`, { method: "PUT", body: JSON.stringify(body) });
      }
      toast.success(isNew ? "Profile created" : "Profile saved");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirm({ message: `Delete profile "${name}"?`, danger: true }))) return;
    try {
      await apiFetch(`/qualityprofiles/${initial.id}`, { method: "DELETE" });
      toast.success("Profile deleted");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? "Add profile" : `Edit ${initial.name}`}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" onClick={remove} className="mr-auto">
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={busy || !name || allowed.length === 0}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="profile-name">
          <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Qualities" description="Worst at top, best at bottom. Tick every quality media-box may download.">
          <div className="rounded-md border border-zinc-800">
            {items.map((item) => {
              const q = qualities.find((x) => x.id === item.qualityId);
              return (
                <label
                  key={item.qualityId}
                  className="flex items-center gap-2 border-b border-zinc-800/60 px-3 py-1.5 text-sm last:border-0"
                >
                  <Checkbox checked={item.allowed} onChange={() => toggle(item.qualityId)} />
                  <span className={item.allowed ? "" : "text-zinc-500"}>{q?.name ?? item.qualityId}</span>
                </label>
              );
            })}
          </div>
        </Field>

        <Field
          label="Upgrade until (cutoff)"
          htmlFor="cutoff-quality"
          description="media-box stops upgrading once a file reaches this quality."
        >
          <Select
            id="cutoff-quality"
            value={cutoffQualityId}
            onChange={(e) => setCutoffQualityId(Number(e.target.value))}
          >
            {allowed.map((i) => (
              <option key={i.qualityId} value={i.qualityId}>
                {qualities.find((q) => q.id === i.qualityId)?.name ?? i.qualityId}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-center gap-3">
          <Switch
            id="upgrade-allowed"
            checked={upgradeAllowed}
            onChange={setUpgradeAllowed}
            aria-label="Upgrade existing files until cutoff is met"
          />
          <label htmlFor="upgrade-allowed" className="text-sm text-zinc-300">
            Upgrade existing files until cutoff is met
          </label>
        </div>
      </div>
    </Modal>
  );
}
