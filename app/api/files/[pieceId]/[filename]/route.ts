import { getStorage } from "@/lib/storage";
import { MIME_TYPES } from "@/lib/http/mime";
import path from "path";

interface RouteParams {
  params: Promise<{ pieceId: string; filename: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId, filename } = await params;

  // Prevent path traversal
  if (pieceId.includes("..") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return new Response("Invalid path", { status: 400 });
  }

  const storage = await getStorage();

  if (!(await storage.exists(pieceId, filename))) {
    return new Response("File not found", { status: 404 });
  }

  try {
    const data = await storage.read(pieceId, filename);
    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": data.length.toString(),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(message, { status: 500 });
  }
}
