import fs from "node:fs";
import { getExportRecord } from "@/lib/exports/store";
import { getStorage } from "@/lib/storage";
import { serveFileWithRange } from "@/lib/http/range";

interface RouteParams {
  params: Promise<{ exportId: string }>;
}

/** `inline` so the Exports tab's <video> plays it; the name survives a "Save as". */
function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "export";
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** GET /api/exports/:exportId/content — the export's bytes, with Range support. */
export async function GET(req: Request, { params }: RouteParams) {
  const { exportId } = await params;
  const row = getExportRecord(exportId);
  if (!row || row.status !== "done" || !row.relPath) return new Response("Export not found", { status: 404 });
  const storage = await getStorage();
  if (!fs.existsSync(storage.localPath(row.pieceId, row.relPath))) return new Response("Missing file", { status: 404 });
  try {
    return serveFileWithRange({
      filePath: await storage.realPathForRead(row.pieceId, row.relPath),
      contentType: row.container === "webm" ? "video/webm" : "video/mp4",
      // A rename reuses nothing (new name, new path), but a delete + re-export can: never cache.
      cacheControl: "no-store",
      request: req,
      extraHeaders: {
        "Content-Disposition": inlineDisposition(row.relPath.split("/").pop() ?? "export.mp4"),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // Resolved out of the piece folder, or gone since the check. Never the error's text (it names paths).
    return new Response("Not found", { status: 404 });
  }
}
