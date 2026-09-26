import path from "path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { isUnsafeUrlParamName } from "@/lib/storage/safe-name";
import { isSafePieceId } from "@/lib/security/pieceId";
import { serveFileWithRange } from "@/lib/http/range";
import { MIME_TYPES } from "@/lib/http/mime";
import { storedBytesServing } from "@/lib/http/media-types";

interface RouteParams {
  params: Promise<{ pieceId: string; filename: string }>;
}

/**
 * GET /api/files/[pieceId]/[filename] — a piece's stored file by its stored
 * name. The app itself fetches by id (`/api/files/by-id/:id/content`): a legal
 * stored name can be one this route refuses as a URL segment (`:`, a trailing
 * dot or space).
 *
 * Same bytes as `/api/files/by-id/:id/content`, so the same serving rule
 * (`storedBytesServing`): the type comes from the file's ROW when it has one —
 * a hosted `x.svg` stored as `image/png` is a PNG, not an SVG document — and
 * only allowlisted media is served inline. proxy.ts gives this path the media
 * CSP (lib/security/media-paths.ts).
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { pieceId, filename } = await params;

  // Prevent path traversal — per SEGMENT, not substring: a title ending in
  // `...` is a legal name (lib/storage/safe-name.ts).
  if (!isSafePieceId(pieceId) || isUnsafeUrlParamName(filename)) {
    return new Response("Invalid path", { status: 400 });
  }

  const storage = await getStorage();

  if (!(await storage.exists(pieceId, filename))) {
    return new Response("File not found", { status: 404 });
  }

  try {
    const row = getDb()
      .select({ contentType: files.contentType })
      .from(files)
      .where(and(eq(files.pieceId, pieceId), eq(files.filename, filename)))
      .get();
    const ext = path.extname(filename).toLowerCase();
    const served = storedBytesServing(row?.contentType ?? MIME_TYPES[ext] ?? null, filename);

    return serveFileWithRange({
      filePath: await storage.realPathForRead(pieceId, filename),
      contentType: served.contentType,
      cacheControl: "public, max-age=31536000, immutable",
      request: req,
      extraHeaders: served.headers,
    });
  } catch {
    // Resolved out of the piece folder, or gone since the check above. Never the error's text:
    // fs errors name the absolute storage path.
    return new Response("Not found", { status: 404 });
  }
}
