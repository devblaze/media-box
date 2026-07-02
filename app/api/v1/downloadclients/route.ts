import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { qbittorrentSettingsSchema, torboxSettingsSchema } from "@/server/download/client";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

function redact(row: { type: string; settings: unknown }) {
  const settings = { ...(row.settings as Record<string, unknown>) };
  if ("password" in settings && settings.password) settings.password = "••••••••";
  if ("apiKey" in settings && settings.apiKey) settings.apiKey = "••••••••";
  return { ...row, settings };
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
