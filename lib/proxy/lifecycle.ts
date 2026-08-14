/**
 * Proxy-file lifecycle helpers — drop the on-disk proxy and reset the
 * `files` row's proxy_* columns.
 *
 * Used by consumers that need to discard an existing proxy (file deletion,
 * proxy-drop tools) without scheduling a new job. Proxy GENERATION goes
 * through the JobManager via the `proxy_gen` runner — this module
 * intentionally does NOT enqueue anything.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";

/**
 * Best-effort: unlink the proxy file for a `fileId` (if one exists on disk)
 * and clear the row's proxy_* columns. Idempotent — safe to call on rows
 * whose proxy was never generated or already dropped.
 *
 * Does NOT remove the source file or the `files` row itself. Callers
 * responsible for those (delete-file.ts handles full file removal).
 */
export function dropProxyFile(
  fileId: string,
  reason: "user" | "lru" | "delete" | "alpha_backfill" = "user",
): void {
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!row) return;
  if (row.proxyStatus === "idle" && !row.proxyFilename) return;

  logger.info({ fileId, event: "drop", reason }, "proxy.drop");

  if (row.proxyFilename) {
    const proxyPath = path.join(
      getLibiStorageDir(),
      row.pieceId ?? "_global",
      row.proxyFilename,
    );
    try {
      fs.unlinkSync(proxyPath);
    } catch {
      /* ignore — already gone is fine */
    }
  }

  db.update(files)
    .set({ proxyFilename: null, proxyStatus: "idle", proxyGeneratedAt: null })
    .where(eq(files.id, fileId))
    .run();

  if (row.pieceId) {
    navigationEmitter.emit("refresh_query", {
      queryKey: "piece",
      pieceId: row.pieceId,
    });
  } else {
    navigationEmitter.emit("refresh_query", { queryKey: "files" });
  }
}
