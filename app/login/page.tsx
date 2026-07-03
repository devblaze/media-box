"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/ui";
import { LoginShowcase } from "@/components/login-showcase";

const inputClass =
  "h-12 w-full rounded-md border border-white/10 bg-zinc-800/60 px-4 text-base text-white placeholder:text-zinc-400 outline-none transition-colors focus:border-white/40 focus:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-white/20";

const FEATURES = [
  "Movies, series & anime — all in one place",
  "Auto-downloads in the best available quality",
  "Requests, subtitles & watch tracking built in",
];

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
    <div className="relative min-h-screen w-full overflow-hidden bg-[#141414] text-white">
      {/* Animated, self-contained preview of the app (decorative). */}
      <LoginShowcase />

      {/* Legibility scrims over the showcase: a full veil on mobile (where the
          panel floats over the demo), and a right-side fade on desktop (where the
          panel hugs the edge). */}
      <div className="pointer-events-none absolute inset-0 bg-black/65 lg:hidden" aria-hidden="true" />
      <div
        className="pointer-events-none absolute inset-0 hidden bg-gradient-to-r from-black/30 via-black/5 to-black/85 lg:block"
        aria-hidden="true"
      />

      {/* Sign-in: a floating card on mobile, a full-height right panel on desktop. */}
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-10 lg:justify-end lg:p-0">
        <div className="w-full max-w-md rounded-xl bg-black/75 p-8 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl md:p-10 lg:flex lg:min-h-screen lg:w-[480px] lg:max-w-none lg:flex-col lg:justify-center lg:rounded-none lg:border-l lg:border-white/10 lg:bg-black/70 lg:px-14 lg:ring-0">
          <div className="mb-8">
            <span className="text-2xl font-extrabold uppercase tracking-tight text-red-600">
              media-box
            </span>
            <h1 className="mt-6 text-3xl font-bold text-white">Sign in</h1>
            <p className="mt-1.5 text-sm text-zinc-400">
              Your personal media library, ready when you are.
            </p>
          </div>

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

          <ul className="mt-8 space-y-2.5 border-t border-white/10 pt-6">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-red-600 text-[10px] font-bold text-white"
                >
                  ✓
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
