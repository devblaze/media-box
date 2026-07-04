import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/** Extension -> Content-Type for the video formats we serve. */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
};

export function contentTypeFor(absPath: string): string {
  return CONTENT_TYPES[path.extname(absPath).toLowerCase()] ?? "application/octet-stream";
}

function toWebStream(nodeStream: Readable): ReadableStream {
  // Node's fs read stream -> Web ReadableStream so it never buffers the whole
  // file in memory. The two ReadableStream declarations differ only nominally.
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

function unsatisfiable(size: number): Response {
  // 416 Range Not Satisfiable: no body, advertise the valid total with `*`.
  return new Response(null, {
    status: 416,
    headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
  });
}

/**
 * Serve a file over HTTP with byte-range (seek) support, hand-rolled because
 * Next.js has no built-in Range handling.
 *
 * - No `Range` header        -> 200, full body, `Content-Length` + `Accept-Ranges`.
 * - `bytes=start-end`        -> 206 partial, `Content-Range` + sized `Content-Length`.
 *   `end` optional (`bytes=N-` means through EOF); `bytes=-N` means the last N bytes.
 * - invalid / unsatisfiable  -> 416 with `Content-Range: bytes * /size` and empty body.
 *
 * `method` "HEAD" returns the same status/headers with no body.
 * Returns 404 if the file is missing or is not a regular file.
 */
export async function streamFile(
  request: Request,
  absPath: string,
  method: "GET" | "HEAD"
): Promise<Response> {
  let size: number;
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return new Response("Not Found", { status: 404 });
    size = s.size;
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const contentType = contentTypeFor(absPath);
  const rangeHeader = request.headers.get("range");

  // --- No Range: full 200 response ---
  if (!rangeHeader) {
    const body = method === "HEAD" ? null : toWebStream(createReadStream(absPath));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Content-Type": contentType,
        // Permissive CORS so Cast/AirPlay receivers can direct-play the file.
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // --- Parse "bytes=start-end" (start and/or end may be empty) ---
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return unsatisfiable(size);
  const startStr = match[1];
  const endStr = match[2];

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: bytes=-N -> last N bytes.
    if (endStr === "") return unsatisfiable(size);
    start = size - Number(endStr);
    if (start < 0) start = 0;
    end = size - 1;
  } else {
    start = Number(startStr);
    // Open-ended bytes=N- runs through EOF.
    end = endStr === "" ? size - 1 : Number(endStr);
  }

  // Validate 0 <= start <= end < size.
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size ||
    end >= size
  ) {
    return unsatisfiable(size);
  }

  const chunkSize = end - start + 1;
  const body = method === "HEAD" ? null : toWebStream(createReadStream(absPath, { start, end }));
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(chunkSize),
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
