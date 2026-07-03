"use client";

import { useEffect, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  DEFAULT_SUBTITLE_STYLE,
  loadSubtitleStyle,
  saveSubtitleStyle,
  subtitleTextStyle,
  SUBTITLE_COLOR_PRESETS,
  type SubtitleStyle,
} from "@/lib/subtitle-style";
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  useToast,
} from "@/components/ui";

interface Account {
  username: string;
  role: "admin" | "user";
  pushoverUserKey: string;
  pushoverConfigured: boolean;
}

export default function AccountPage() {
  const { data, mutate } = useApi<Account>("/account");
  const toast = useToast();

  // Change password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  // Pushover
  const [pushoverUserKey, setPushoverUserKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  // Subtitle appearance — stored in the browser and applied by the video player.
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);

  useEffect(() => {
    if (data) setPushoverUserKey(data.pushoverUserKey);
  }, [data]);

  useEffect(() => {
    setSubStyle(loadSubtitleStyle());
  }, []);

  function updateSubStyle(patch: Partial<SubtitleStyle>) {
    const next = { ...subStyle, ...patch };
    setSubStyle(next);
    saveSubtitleStyle(next);
  }

  async function changePassword() {
    setPwError(null);
    if (newPassword.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match.");
      return;
    }
    setChanging(true);
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setChanging(false);
    }
  }

  async function savePushover() {
    setSavingKey(true);
    try {
      await apiFetch("/account", {
        method: "PUT",
        body: JSON.stringify({ pushoverUserKey }),
      });
      await mutate();
      toast.success("Notification settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingKey(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:py-12">
      <h1 className="mb-6 text-2xl font-semibold">Account</h1>

      <div className="space-y-4">
        <Field label="Username">
          <Input readOnly value={data?.username ?? ""} className="text-zinc-400" />
        </Field>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <Field label="Current password" htmlFor="current-password">
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </Field>
            <Field label="New password" htmlFor="new-password">
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
            <Field
              label="Confirm new password"
              htmlFor="confirm-password"
              error={pwError}
              description="At least 8 characters."
            >
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </Field>
            <Button
              onClick={changePassword}
              loading={changing}
              disabled={
                changing || !currentPassword || !newPassword || !confirmPassword
              }
            >
              {changing ? "Changing…" : "Change password"}
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notifications (Pushover)</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {data && !data.pushoverConfigured && (
              <Callout tone="info" title="Pushover isn't set up yet">
                Ask an admin to add the Pushover app token in Settings → General.
              </Callout>
            )}
            <Field
              label="Pushover user key"
              htmlFor="pushover-user-key"
              description="Get your user key from pushover.net — you'll get a push notification when a title you requested becomes available."
            >
              <Input
                id="pushover-user-key"
                value={pushoverUserKey}
                onChange={(e) => setPushoverUserKey(e.target.value)}
                className="font-mono"
                placeholder="Pushover user key"
              />
            </Field>
            <Button onClick={savePushover} loading={savingKey} disabled={savingKey || !data}>
              {savingKey ? "Saving…" : "Save"}
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Subtitle style</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-sm text-zinc-400">
              Choose how subtitles look during playback. Changes are saved instantly on this device
              and apply the next time you open a video.
            </p>

            {/* Live preview */}
            <div className="flex min-h-28 items-end justify-center rounded-md bg-gradient-to-b from-zinc-600 via-zinc-800 to-zinc-950 p-4">
              <span style={subtitleTextStyle(subStyle, { preview: true })}>
                The quick brown fox
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Size" htmlFor="sub-size">
                <Select
                  id="sub-size"
                  value={subStyle.fontSize}
                  onChange={(e) =>
                    updateSubStyle({ fontSize: e.target.value as SubtitleStyle["fontSize"] })
                  }
                >
                  <option value="sm">Small</option>
                  <option value="md">Medium</option>
                  <option value="lg">Large</option>
                  <option value="xl">Extra large</option>
                </Select>
              </Field>

              <Field label="Font" htmlFor="sub-font">
                <Select
                  id="sub-font"
                  value={subStyle.fontFamily}
                  onChange={(e) =>
                    updateSubStyle({ fontFamily: e.target.value as SubtitleStyle["fontFamily"] })
                  }
                >
                  <option value="sans">Sans-serif</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Monospace</option>
                </Select>
              </Field>

              <Field label="Background" htmlFor="sub-bg">
                <Select
                  id="sub-bg"
                  value={subStyle.background}
                  onChange={(e) =>
                    updateSubStyle({ background: e.target.value as SubtitleStyle["background"] })
                  }
                >
                  <option value="none">None</option>
                  <option value="semi">Semi-transparent</option>
                  <option value="solid">Solid box</option>
                </Select>
              </Field>

              <Field label="Edge" htmlFor="sub-edge">
                <Select
                  id="sub-edge"
                  value={subStyle.edge}
                  onChange={(e) =>
                    updateSubStyle({ edge: e.target.value as SubtitleStyle["edge"] })
                  }
                >
                  <option value="none">None</option>
                  <option value="outline">Outline</option>
                  <option value="shadow">Drop shadow</option>
                </Select>
              </Field>
            </div>

            <Field label="Text color">
              <div className="flex flex-wrap items-center gap-2">
                {SUBTITLE_COLOR_PRESETS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    aria-label={c.label}
                    title={c.label}
                    onClick={() => updateSubStyle({ color: c.value })}
                    className={cn(
                      "size-8 rounded-full border-2 transition-transform hover:scale-110",
                      subStyle.color.toLowerCase() === c.value.toLowerCase()
                        ? "border-amber-400"
                        : "border-zinc-700"
                    )}
                    style={{ backgroundColor: c.value }}
                  />
                ))}
                <label className="ml-1 inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="color"
                    value={subStyle.color}
                    onChange={(e) => updateSubStyle({ color: e.target.value })}
                    className="size-8 cursor-pointer rounded border border-zinc-700 bg-transparent p-0"
                  />
                  Custom
                </label>
              </div>
            </Field>

            <Button variant="outline" size="sm" onClick={() => updateSubStyle(DEFAULT_SUBTITLE_STYLE)}>
              Reset to defaults
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
