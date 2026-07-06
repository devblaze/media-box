import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { qbittorrentSettingsSchema, torboxSettingsSchema } from "@/server/download/client";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

/** Placeholder shown to the client in place of a stored secret. */
export const REDACTED = "••••••••";
/** Secret setting keys that are redacted on read and merged back on write/test. */
const SECRET_KEYS = ["password", "apiKey"] as const;

function redact(row: { type: string; settings: unknown }) {
  const settings = { ...(row.settings as Record<string, unknown>) };
  for (const key of SECRET_KEYS) {
    if (key in settings && settings[key]) settings[key] = REDACTED;
  }
  return { ...row, settings };
}

/**
 * Restore stored secrets for any field that arrived as the redaction placeholder,
 * so editing a client (or testing edited settings) without re-typing a secret
 * keeps the real value instead of persisting/sending "••••••••".
 */
export function mergeSecrets(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...incoming };
  for (const key of SECRET_KEYS) {
    if (merged[key] === REDACTED) merged[key] = stored[key];
  }
  return merged;
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const rows = db
      .select()
      .from(schema.downloadClients)
      .orderBy(asc(schema.downloadClients.priority))
      .all();
    return ok(rows.map(redact));
  } catch (err) {
    return serverError(err);
  }
}

export const clientBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("qbittorrent"),
    name: z.string().min(1),
    settings: qbittorrentSettingsSchema,
    enabled: z.boolean().optional(),
    priority: z.number().int().min(1).optional(),
    removeCompletedDownloads: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("torbox"),
    name: z.string().min(1),
    settings: torboxSettingsSchema,
    enabled: z.boolean().optional(),
    priority: z.number().int().min(1).optional(),
    removeCompletedDownloads: z.boolean().optional(),
  }),
]);

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const input = clientBodySchema.parse(await request.json());
    const db = getDb();
    const row = db.insert(schema.downloadClients).values(input).returning().get();
    return ok(redact(row), { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
