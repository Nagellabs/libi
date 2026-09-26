import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { isUnsafeStorageName } from "@/lib/storage/safe-name";
import { serveFileWithRange } from "@/lib/http/range";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file || file.proxyStatus !== "ready" || !file.proxyFilename) {
    return new Response("Proxy not ready", { status: 404 });
  }

  // Defensive path-traversal check. `proxyFilename` is always server-generated
  // via `proxyNameFor(filename)` so the attack surface is effectively zero,
  // but we mirror the guard in the sibling `content/route.ts` so any future
  // change that lets user input bleed into the column fails closed. Per
  // SEGMENT, not substring: a title ending in `...` is a legal name.
  if (isUnsafeStorageName(file.proxyFilename)) {
    return new Response("Invalid path", { status: 400 });
  }

  const storage = await getStorage();
  if (!(await storage.exists(file.pieceId, file.proxyFilename))) {
    return new Response("Proxy missing", { status: 404 });
  }

  // ETag built from generation timestamp so the browser knows when
  // to revalidate after an invalidate+regen cycle.
  const etag = file.proxyGeneratedAt
    ? `"${file.proxyGeneratedAt.getTime()}"`
    : `"${file.id}"`;

  // Contained, or not served at all: a name that resolves out of the piece folder (a planted
  // symlink) or vanished since the check above is a 404 — never a thrown error, whose text would
  // carry the resolved path.
  let filePath: string;
  try {
    filePath = await storage.realPathForRead(file.pieceId, file.proxyFilename);
  } catch {
    return new Response("Proxy missing", { status: 404 });
  }

  return serveFileWithRange({
    filePath,
    // An audio file's proxy is an M4A (proxy-gen.ts).
    contentType: file.proxyFilename.endsWith(".m4a") ? "audio/mp4" : "video/mp4",
    etag,
    cacheControl: "no-cache, must-revalidate",
    request: req,
  });
}
