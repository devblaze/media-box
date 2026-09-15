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

/**
 * A 400 that names the fields that failed validation.
 *
 * The shared `apiFetch` surfaces only the `error` string, so an `issues` array
 * alone reaches the user as a bare "Validation failed" and tells them nothing.
 * The field paths go in the message; the raw issues still ride along for
 * anything reading the API directly.
 */
export function invalidBody(err: unknown, fallback = "Request body was not valid JSON") {
  if (!(err instanceof ZodError)) return badRequest(fallback);
  const named = err.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.join(".") : "body"} (${i.message})`)
    .join(", ");
  const more = err.issues.length > 3 ? ` and ${err.issues.length - 3} more` : "";
  return NextResponse.json(
    { error: `Invalid request body: ${named}${more}`, issues: err.issues },
    { status: 400 }
  );
}

/** The request is well-formed but the current state refuses it (409). */
export function conflict(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

export function serverError(err: unknown) {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "Validation failed", issues: err.issues }, { status: 400 });
  }
  // A blocked file operation (read-only mode) is a user-recoverable conflict, not a
  // 500. Matched by name so this module needn't import server-only DB code.
  if (err instanceof Error && err.name === "MediaWritesDisabledError") {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api]", err);
  return NextResponse.json({ error: message }, { status: 500 });
}
