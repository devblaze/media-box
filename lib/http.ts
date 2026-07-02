import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(err: unknown) {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "Validation failed", issues: err.issues }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api]", err);
  return NextResponse.json({ error: message }, { status: 500 });
}
