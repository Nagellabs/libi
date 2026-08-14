import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
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
  // but we mirror the guard in the sibling `content/route.ts:40` so any future
  // change that lets user input bleed into the column fails closed.
  if (
    file.proxyFilename.includes("..") ||
    file.proxyFilename.includes("/") ||
    file.proxyFilename.includes("\\")
  ) {
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

  return serveFileWithRange({
    filePath: await storage.realPathForRead(file.pieceId, file.proxyFilename),
    contentType: "video/mp4",
    etag,
    cacheControl: "no-cache, must-revalidate",
    request: req,
  });
}
