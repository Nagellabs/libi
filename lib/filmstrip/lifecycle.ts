/**
 * Filmstrip-file lifecycle helpers — drop the on-disk sprite and reset the
 * `files` row's filmstrip_* columns. Mirrors `lib/proxy/lifecycle.ts`.
 *
 * Used by consumers that need to discard an existing sprite (file deletion,
 * LRU eviction) without scheduling a new job. Filmstrip GENERATION goes
 * through the JobManager via the `filmstrip_gen` runner — this module
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
 * Best-effort: unlink the filmstrip sprite for a `fileId` (if one exists on
 * disk) and clear the row's filmstrip_* columns. Idempotent — safe to call on
 * rows whose sprite was never generated or already dropped.
 *
 * Does NOT remove the source file or the `files` row itself.
 */
export function dropFilmstripFile(
  fileId: string,
  reason: "user" | "lru" | "delete" = "user",
): void {
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!row) return;
  if (row.filmstripStatus === "idle" && !row.filmstripFilename) return;

  logger.info({ fileId, event: "drop", reason, tag: "filmstrip" }, "filmstrip.drop");

  if (row.filmstripFilename) {
    const filmstripPath = path.join(
      getLibiStorageDir(),
      row.pieceId ?? "_global",
      row.filmstripFilename,
    );
    try {
      fs.unlinkSync(filmstripPath);
    } catch {
      /* ignore — already gone is fine */
    }
  }

  db.update(files)
    .set({
      filmstripFilename: null,
      filmstripStatus: "idle",
      filmstripGeneratedAt: null,
      filmstripFrames: null,
      filmstripHeight: null,
    })
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
