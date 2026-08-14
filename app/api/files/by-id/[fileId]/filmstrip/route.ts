import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { serveFileWithRange } from "@/lib/http/range";

/**
 * GET /api/files/by-id/[fileId]/filmstrip — serve the timeline filmstrip
 * sprite bytes when `filmstripStatus === 'ready'`; 404 otherwise (the polling
 * hook retries / the bar keeps its solid fallback). Mirrors the proxy serve
 * route.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file || file.filmstripStatus !== "ready" || !file.filmstripFilename) {
    return new Response("Filmstrip not ready", { status: 404 });
  }

  // Defensive path-traversal guard — `filmstripFilename` is always
  // server-generated (`<basename>-filmstrip.jpg`), so the surface is zero,
  // but fail closed mirroring the proxy route.
  if (
    file.filmstripFilename.includes("..") ||
    file.filmstripFilename.includes("/") ||
    file.filmstripFilename.includes("\\")
  ) {
    return new Response("Invalid path", { status: 400 });
  }

  const storage = await getStorage();
  if (!(await storage.exists(file.pieceId, file.filmstripFilename))) {
    return new Response("Filmstrip missing", { status: 404 });
  }

  const etag = file.filmstripGeneratedAt
    ? `"${file.filmstripGeneratedAt.getTime()}"`
    : `"${file.id}"`;

  return serveFileWithRange({
    filePath: await storage.realPathForRead(file.pieceId, file.filmstripFilename),
    contentType: "image/jpeg",
    etag,
    cacheControl: "no-cache, must-revalidate",
    request: req,
  });
}
