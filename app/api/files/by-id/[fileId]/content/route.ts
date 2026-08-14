import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { serveFileWithRange } from "@/lib/http/range";
import { MIME_TYPES } from "@/lib/http/mime";

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

  if (file.filename.includes("..") || file.filename.includes("/") || file.filename.includes("\\")) {
    return new Response("Invalid path", { status: 400 });
  }

  const storage = await getStorage();
  if (!(await storage.exists(file.pieceId, file.filename))) {
    return new Response("File not found", { status: 404 });
  }

  try {
    const ext = path.extname(file.filename).toLowerCase();
    const contentType = file.contentType ?? MIME_TYPES[ext] ?? "application/octet-stream";

    return serveFileWithRange({
      filePath: await storage.realPathForRead(file.pieceId, file.filename),
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
      request: req,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(message, { status: 500 });
  }
}
