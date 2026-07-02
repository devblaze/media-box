import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { getRequestUser } from "@/server/auth/auth-service";
import { subtitleAbsPath } from "@/server/subtitles/subtitle-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve a subtitle sidecar as WebVTT (converting from SRT) for the in-app player. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/subtitles/[id]/vtt">) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const abs = subtitleAbsPath(Number(id));
  if (!abs) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const raw = await fs.readFile(abs, "utf8");
    // Already VTT? serve as-is. Otherwise convert SRT: comma → dot in timestamps + header.
    const vtt = raw.trimStart().startsWith("WEBVTT")
      ? raw
      : `WEBVTT\n\n${raw.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
    return new NextResponse(vtt, {
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
