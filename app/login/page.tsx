"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/ui";

const inputClass =
  "h-12 w-full rounded-md border border-white/10 bg-zinc-800/60 px-4 text-base text-white placeholder:text-zinc-400 outline-none transition-colors focus:border-white/40 focus:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-white/20";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // first run? send to setup
    fetch("/api/v1/auth/setup")
      .then((r) => r.json())
      .then((d) => {
        if (d.setupRequired) router.replace("/setup");
      })
      .catch(() => {});
  }, [router]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Login failed");
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden text-white">
      <div className="auth-bg fixed inset-0 -z-10" aria-hidden="true" />

      <header className="px-6 py-5 md:px-12">
        <span className="text-2xl font-extrabold uppercase tracking-tight text-red-600">
          media-box
        </span>
      </header>

      <main className="flex min-h-[calc(100vh-5rem)] items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md rounded-lg bg-black/70 p-8 shadow-2xl ring-1 ring-white/5 backdrop-blur md:p-12">
          <h1 className="mb-6 text-3xl font-bold text-white">Sign In</h1>

          <form onSubmit={login} className="space-y-4">
            <Field label="Username" htmlFor="username">
              <input
                id="username"
                className={inputClass}
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </Field>

            <Field label="Password" htmlFor="password">
              <input
                id="password"
                type="password"
                className={inputClass}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            {error && (
              <div
                role="alert"
                className="rounded-md bg-red-600/15 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !username || !password}
              aria-busy={busy || undefined}
              className="mt-2 flex h-12 w-full items-center justify-center rounded-md bg-red-600 text-base font-semibold text-white transition-colors hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="mt-8 text-sm text-zinc-500">
            Your personal media library, ready when you are.
          </p>
        </div>
      </main>
    </div>
  );
}
