import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getRequestUser } from "@/server/auth/auth-service";
import { subtitleAbsPath } from "@/server/subtitles/subtitle-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ASS/SSA time "0:00:20.00" → VTT "00:00:20.000". */
function assTime(t: string): string {
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{2})$/);
  if (!m) return "00:00:00.000";
  const [, h, mm, ss, cc] = m;
  return `${h.padStart(2, "0")}:${mm}:${ss}.${cc}0`;
}

/** Minimal ASS/SSA → WebVTT: extract Dialogue cues, strip override tags. */
function assToVtt(raw: string): string {
  const cues: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const parts = line.slice("Dialogue:".length).split(",");
    if (parts.length < 10) continue;
    const text = parts
      .slice(9)
      .join(",")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/gi, "\n")
      .trim();
    if (text) cues.push(`${assTime(parts[1])} --> ${assTime(parts[2])}\n${text}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}`;
}

/** Serve a subtitle sidecar as WebVTT (SRT / VTT / ASS) for the in-app player. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/subtitles/[id]/vtt">) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const abs = subtitleAbsPath(Number(id));
  if (!abs) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const raw = await fs.readFile(abs, "utf8");
    const ext = path.extname(abs).toLowerCase();
    let vtt: string;
    if (raw.trimStart().startsWith("WEBVTT")) {
      vtt = raw; // already VTT
    } else if (ext === ".ass" || ext === ".ssa") {
      vtt = assToVtt(raw);
    } else {
      // SRT / SUB: comma → dot in timestamps + header
      vtt = `WEBVTT\n\n${raw.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
    }
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
