"use client";

import useSWR from "swr";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export function useApi<T = unknown>(path: string | null) {
  return useSWR<T>(path, (p: string) => apiFetch<T>(p));
}
