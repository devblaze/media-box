"use client";

import { useEffect, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
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

  useEffect(() => {
    if (data) setPushoverUserKey(data.pushoverUserKey);
  }, [data]);

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
      </div>
    </div>
  );
}
