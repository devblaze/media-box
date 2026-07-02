"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Card, CardBody, Field, Input } from "@/components/ui";

export default function SetupPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function setup(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Setup failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardBody>
          <form onSubmit={setup} className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold text-amber-400">Welcome to media-box</h1>
              <p className="text-sm text-zinc-400">Create the admin account to get started.</p>
            </div>

            <Field label="Username" htmlFor="username">
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </Field>

            <Field label="Password" htmlFor="password" description="Min 8 characters">
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <Field label="Confirm password" htmlFor="confirm">
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>

            {error && <Callout tone="danger">{error}</Callout>}

            <Button
              type="submit"
              size="lg"
              className="w-full justify-center"
              loading={busy}
              disabled={busy || !username || password.length < 8}
            >
              {busy ? "Creating…" : "Create admin account"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
