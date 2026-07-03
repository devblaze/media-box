import type { NextRequest } from "next/server";
import { z } from "zod";
import { getSettings, updateSettings } from "@/server/settings/settings-service";
import { requireAdmin } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return ok(getSettings());
  } catch (err) {
    return serverError(err);
  }
}

const patchSchema = z.object({
  tmdbApiKey: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
  urlBase: z.string().optional(),
  downloadsPath: z.string().optional(),
  moviesPath: z.string().optional(),
  seriesPath: z.string().optional(),
  animePath: z.string().optional(),
  importMode: z.enum(["auto", "hardlink", "copy", "move"]).optional(),
  transcodeHwAccel: z.enum(["none", "vaapi", "qsv", "nvenc"]).optional(),
  transcodeVaapiDevice: z.string().optional(),
  maxTranscodeSessions: z.coerce.number().int().min(1).max(10).optional(),
  maxBacklogGrabsPerRun: z.coerce.number().int().min(0).max(50).optional(),
  subtitleLanguages: z.string().optional(),
  subtitleProvider: z.enum(["none", "opensubtitles"]).optional(),
  subtitleHearingImpaired: z.coerce.boolean().optional(),
  openSubtitlesApiKey: z.string().optional(),
  openSubtitlesUsername: z.string().optional(),
  openSubtitlesPassword: z.string().optional(),
  pushoverAppToken: z.string().optional(),
});

export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const patch = patchSchema.parse(await request.json());
    return ok(updateSettings(patch));
  } catch (err) {
    return serverError(err);
  }
}
