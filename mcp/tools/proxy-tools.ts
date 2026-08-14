import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { dropProxyFile } from "@/lib/proxy/lifecycle";
import { enqueueJobOnServer, logProxyGenEnqueueFailure } from "@/mcp/jobs-client";
import type { ToolResult } from "./types";

export async function regenerateProxy(params: { fileId: string }): Promise<ToolResult> {
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  if (!row) return { success: false, error: "File not found" };
  if (row.type !== "video") return { success: false, error: "Not a video file" };

  // Drop the existing proxy (file + row state) so the new run starts clean,
  // then enqueue a fresh job (forceNew: true guarantees the JobManager
  // discards any prior matching row before queuing the new one).
  dropProxyFile(params.fileId, "user");
  void enqueueJobOnServer(
    "proxy_gen",
    { fileId: params.fileId },
    { pieceId: row.pieceId, fileId: params.fileId, forceNew: true },
  ).catch((err) => logProxyGenEnqueueFailure(params.fileId, err));

  return { success: true, data: { fileId: params.fileId, status: "generating" } };
}

export async function dropProxies(params: { pieceId: string }): Promise<ToolResult> {
  const db = getDb();
  const rows = db
    .select()
    .from(files)
    .where(eq(files.pieceId, params.pieceId))
    .all();
  let count = 0;
  for (const row of rows) {
    if (row.type === "video" && row.proxyStatus === "ready") {
      dropProxyFile(row.id, "user");
      count++;
    }
  }
  return { success: true, data: { dropped: count } };
}
