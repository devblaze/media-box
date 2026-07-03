import type { NextRequest } from "next/server";
import { z } from "zod";
import { testTranscode } from "@/server/transcode/session-manager";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

export const runtime = "nodejs";

const bodySchema = z.object({
  transcodeHwAccel: z.enum(["none", "vaapi", "qsv", "nvenc"]),
  transcodeVaapiDevice: z.string().optional(),
});

// Runs a short synthetic ffmpeg encode with the chosen hardware-accel path and
// reports whether it works, so the admin can verify GPU transcoding is enabled.
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { transcodeHwAccel, transcodeVaapiDevice } = bodySchema.parse(await request.json());
    return ok(await testTranscode(transcodeHwAccel, transcodeVaapiDevice ?? "/dev/dri/renderD128"));
  } catch (err) {
    return serverError(err);
  }
}
