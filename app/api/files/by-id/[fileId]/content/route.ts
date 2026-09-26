import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { isUnsafeStorageName } from "@/lib/storage/safe-name";
import { serveFileWithRange } from "@/lib/http/range";
import { MIME_TYPES } from "@/lib/http/mime";
import { storedBytesServing } from "@/lib/http/media-types";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  const { fileId } = await params;

  const db = getDb();
  const [file] = db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
    .all();

  if (!file) {
    return new Response("File not found", { status: 404 });
  }

  // Per SEGMENT, not substring: a title ending in `...` is a legal name.
  if (isUnsafeStorageName(file.filename)) {
    return new Response("Invalid path", { status: 400 });
  }

  const storage = await getStorage();
  if (!(await storage.exists(file.pieceId, file.filename))) {
    return new Response("File not found", { status: 404 });
  }

  try {
    const ext = path.extname(file.filename).toLowerCase();
    const stored = file.contentType ?? MIME_TYPES[ext] ?? null;
    // Never trusted to be safe to render: only allowlisted media goes out
    // inline, everything else as an attachment (lib/http/media-types.ts).
    const served = storedBytesServing(stored, file.filename);

    return serveFileWithRange({
      filePath: await storage.realPathForRead(file.pieceId, file.filename),
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
