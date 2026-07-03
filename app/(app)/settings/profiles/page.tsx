"use client";

import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import type { QualityProfile } from "@/lib/types";
import {
  Badge,
  Button,
  Callout,
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
  const toast = useToast();
  const confirm = useConfirm();
  const { data: profiles, mutate } = useApi<QualityProfile[]>("/qualityprofiles");
  const { data: qualities } = useApi<QualityDefinition[]>("/qualitydefinitions");
  const [editing, setEditing] = useState<Partial<QualityProfile> | null>(null);
  const [merging, setMerging] = useState(false);

  // Profiles sharing a name (case-insensitive) are duplicates; count how many
  // rows are redundant (everything beyond the first per name).
  const duplicateCount = profiles
    ? profiles.length - new Set(profiles.map((p) => p.name.trim().toLowerCase())).size
    : 0;

  async function mergeDuplicates() {
    if (
      !(await confirm({
        message:
          "Merge duplicate quality profiles? Series and movies on a duplicate are reassigned to the kept profile, then the duplicates are deleted.",
      }))
    )
      return;
    setMerging(true);
    try {
      const res = await apiFetch<{ merged: number }>("/qualityprofiles/dedupe", { method: "POST" });
      toast.success(
        res.merged > 0 ? `Merged ${res.merged} duplicate profile(s)` : "No duplicates to merge"
      );
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  }

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

      {duplicateCount > 0 && (
        <Callout tone="warning" title={`${duplicateCount} duplicate profile(s) found`}>
          <div className="flex items-center justify-between gap-3">
            <p>
              Some profiles share a name (often from re-running a migration). Merging keeps the
              oldest of each name, moves any series and movies onto it, and deletes the rest.
            </p>
            <Button size="sm" onClick={mergeDuplicates} loading={merging} disabled={merging}>
              Merge duplicates
            </Button>
          </div>
        </Callout>
      )}

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
  const [preferredTerms, setPreferredTerms] = useState(initial.preferredTerms ?? []);
  const [requiredTerms, setRequiredTerms] = useState(initial.requiredTerms ?? []);
  const [ignoredTerms, setIgnoredTerms] = useState(initial.ignoredTerms ?? []);
  const [busy, setBusy] = useState(false);

  function toggle(qualityId: number) {
    setItems((prev) =>
      prev.map((i) => (i.qualityId === qualityId ? { ...i, allowed: !i.allowed } : i))
    );
  }

  function addPreferred() {
    setPreferredTerms((prev) => [...prev, { term: "", score: 0 }]);
  }
  function updatePreferred(index: number, patch: Partial<{ term: string; score: number }>) {
    setPreferredTerms((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  function removePreferred(index: number) {
    setPreferredTerms((prev) => prev.filter((_, i) => i !== index));
  }

  const allowed = items.filter((i) => i.allowed);

  async function save() {
    setBusy(true);
    try {
      const body = {
        name,
        upgradeAllowed,
        cutoffQualityId,
        items,
        preferredTerms: preferredTerms.filter((p) => p.term.trim() !== ""),
        requiredTerms: requiredTerms.filter((t) => t.trim() !== ""),
        ignoredTerms: ignoredTerms.filter((t) => t.trim() !== ""),
      };
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

        <div className="space-y-4 border-t border-zinc-800 pt-4">
          <HowTo title="Preferred release groups & filters">
            <p>
              Fine-tune which specific releases media-box prefers or rejects within your allowed
              qualities. A term matches the release title as a case-insensitive substring, or as a
              regex if you wrap it in slashes — e.g. <code>/x265|hevc/</code>.
            </p>
            <ul>
              <li>
                <strong>Preferred terms</strong> — matching releases gain the term&apos;s score (use
                a negative score to avoid). The release with the highest total score wins, but
                non-matching releases stay eligible, so media-box still grabs one if your preferred
                release isn&apos;t available. Example: term <code>YIFY</code> score <code>50</code>.
              </li>
              <li>
                <strong>Required terms</strong> — if you add any, a release must contain at least one
                to be eligible.
              </li>
              <li>
                <strong>Ignored terms</strong> — a release is rejected if it contains any of these.
              </li>
            </ul>
            <p>
              Example setup: a <strong>Movies</strong> profile preferring <code>YIFY</code> and{" "}
              <code>YTS</code>, and an <strong>Anime</strong> profile preferring your favourite anime
              group — then assign the Anime profile to your anime series.
            </p>
          </HowTo>

          <Field
            label="Preferred terms"
            description="Matching releases gain the score; the highest total wins, but other releases are still grabbed if none match."
          >
            <div className="space-y-2">
              {preferredTerms.length === 0 && (
                <p className="text-xs text-zinc-500">No preferred terms yet.</p>
              )}
              {preferredTerms.map((pt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={pt.term}
                    placeholder="e.g. YIFY or /x265|hevc/"
                    onChange={(e) => updatePreferred(i, { term: e.target.value })}
                  />
                  <Input
                    type="number"
                    value={pt.score}
                    aria-label="Score"
                    className="w-24 shrink-0"
                    onChange={(e) => updatePreferred(i, { score: Number(e.target.value) })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove preferred term"
                    onClick={() => removePreferred(i)}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addPreferred}>
                Add preferred term
              </Button>
            </div>
          </Field>

          <Field
            label="Required terms"
            description="If any are set, a release must contain at least one of these to be eligible."
          >
            <TermList
              values={requiredTerms}
              onChange={setRequiredTerms}
              placeholder="e.g. 1080p or /x265|hevc/"
              addLabel="Add required term"
            />
          </Field>

          <Field
            label="Ignored terms"
            description="A release is rejected if its title contains any of these."
          >
            <TermList
              values={ignoredTerms}
              onChange={setIgnoredTerms}
              placeholder="e.g. CAM or /\.rar$/"
              addLabel="Add ignored term"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/** Editor for a simple list of string terms (required / ignored). */
function TermList({
  values,
  onChange,
  placeholder,
  addLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {values.length === 0 && <p className="text-xs text-zinc-500">None yet.</p>}
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(values.map((v, j) => (j === i ? e.target.value : v)))}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove term"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...values, ""])}>
        {addLabel}
      </Button>
    </div>
  );
}
