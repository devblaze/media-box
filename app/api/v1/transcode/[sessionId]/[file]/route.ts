import type { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getRequestUser } from "@/server/auth/auth-service";
import { getSession, touch } from "@/server/transcode/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string; file: string }> };

// Only ever serve the HLS playlist or a numbered segment. This whitelist is the
// single defence against path traversal — no "..", no separators can pass.
const FILE_RE = /^(index\.m3u8|seg\d{5}\.ts)$/;

const PLAYLIST_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function toWebStream(nodeStream: Readable): ReadableStream {
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

export async function GET(request: NextRequest, ctx: Ctx): Promise<Response> {
  if (!getRequestUser(request)) return new Response("Unauthorized", { status: 401 });

  const { sessionId, file } = await ctx.params;
  if (!FILE_RE.test(file)) return new Response("Bad Request", { status: 400 });

  const session = getSession(sessionId);
  if (!session) return new Response("Not Found", { status: 404 });
  touch(sessionId);

  const abs = path.join(session.dir, file);
  const isPlaylist = file === "index.m3u8";

  if (isPlaylist) {
    // At the very start ffmpeg may not have flushed the playlist yet — wait briefly.
    const deadline = Date.now() + PLAYLIST_WAIT_MS;
    while (!(await exists(abs))) {
      if (Date.now() >= deadline || session.status === "error") {
        return new Response("Not Found", { status: 404 });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } else if (!(await exists(abs))) {
    // Segment not produced yet — hls.js will retry.
    return new Response("Not Found", { status: 404 });
  }

  const contentType = isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t";
  return new Response(toWebStream(createReadStream(abs)), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // Playlist is a growing live document; segments are immutable once written.
      "Cache-Control": isPlaylist ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}
