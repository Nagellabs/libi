import { createReadStream, statSync } from "node:fs";
import { toWebReadable } from "./streams";

/**
 * Serve a local file with HTTP `Range` request support.
 *
 * Why this matters for video: without `Accept-Ranges: bytes` and `206
 * Partial Content` responses, browsers mark `<video>.seekable` as an
 * empty range. The element can still stream forward from 0, but any
 * attempt to write `video.currentTime = X` for X > 0 silently fails —
 * no `seeking` event fires, `currentTime` stays at 0. That's what made
 * scrubbing look broken in the editor: the transport would move, but
 * the hidden `<video>` couldn't jump.
 *
 * The spec: RFC 7233. We implement the subset browsers actually use —
 * a single `bytes=START-END` (END optional, START optional for
 * suffix-length). Multipart ranges aren't worth supporting: no browser
 * issues them for media.
 */
export interface ServeFileRangeOptions {
  /** Absolute path on disk. Caller must already have validated traversal. */
  filePath: string;
  /** Response `Content-Type`. Caller picks the right MIME. */
  contentType: string;
  /** Optional `ETag` (already quoted). */
  etag?: string;
  /** Full `Cache-Control` string. Defaults to no-cache for media. */
  cacheControl?: string;
  /** Request object — we read `Range` and `If-None-Match` from it. */
  request: Request;
}

export function serveFileWithRange(options: ServeFileRangeOptions): Response {
  const { filePath, contentType, etag, cacheControl, request } = options;

  const stat = statSync(filePath);
  const totalSize = stat.size;

  // ETag revalidation short-circuit — same behavior the original routes
  // had, preserved so conditional GETs don't regress to 200.
  if (etag) {
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": cacheControl ?? "no-cache, must-revalidate",
        },
      });
    }
  }

  const rangeHeader = request.headers.get("range");
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl ?? "no-cache, must-revalidate",
  };
  if (etag) baseHeaders.ETag = etag;

  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, totalSize);
    if (!parsed) {
      // Malformed or unsatisfiable. Per spec, respond 416 with a
      // Content-Range header so the client knows the valid extent.
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` },
      });
    }
    const { start, end } = parsed;
    const chunkLength = end - start + 1;
    const stream = createReadStream(filePath, { start, end });
    return new Response(toWebReadable(stream), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": chunkLength.toString(),
        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      },
    });
  }

  // No Range header: stream the whole file, but still advertise range
  // support so the browser knows it CAN seek later.
  const stream = createReadStream(filePath);
  return new Response(toWebReadable(stream), {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Length": totalSize.toString(),
    },
  });
}

/**
 * Parse a single-range `bytes=START-END` value. Returns clamped start/end
 * as inclusive byte offsets, or null if the request is unsatisfiable.
 *
 *   bytes=0-499      first 500 bytes
 *   bytes=500-       byte 500 to end
 *   bytes=-500       last 500 bytes (suffix)
 */
export function parseByteRange(
  header: string,
  totalSize: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;

  if (startStr === "" && endStr === "") return null;

  // Suffix form: bytes=-N
  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null;

  let end: number;
  if (endStr === "") {
    end = totalSize - 1;
  } else {
    end = Number(endStr);
    if (!Number.isFinite(end) || end < start) return null;
    if (end >= totalSize) end = totalSize - 1;
  }

  return { start, end };
}
