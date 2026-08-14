import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { removeReferencesToFile } from "@/lib/composition/persistence";
import { dropProxyFile } from "@/lib/proxy/lifecycle";
import { dropFilmstripFile } from "@/lib/filmstrip/lifecycle";
import { serverLogger as logger } from "@/lib/logger";
import { listTracksByFile, deleteTrackRow } from "@/lib/tracking/repo";
import { deleteTrack as deleteTrackSidecar } from "@/lib/tracking/storage";

export interface DeleteFileResult {
  success: boolean;
  fileId: string;
  filename?: string;
  removedClips: string[];
  removedOverlays: string[];
  error?: string;
}

/**
 * Permanently delete a file: drops its proxy, removes from disk, removes
 * from DB, cascades to audio clips / overlays. The only
 * destructive flow in the system. Both the HTTP route and the MCP tool
 * funnel through here so the cascade is identical regardless of caller.
 */
export async function deleteFile(fileId: string): Promise<DeleteFileResult> {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) {
    return {
      success: false,
      fileId,
      removedClips: [],
      removedOverlays: [],
      error: "File not found",
    };
  }

  dropProxyFile(fileId, "delete");
  dropFilmstripFile(fileId, "delete");

  try {
    const storage = await getStorage();
    await storage.delete(file.pieceId, file.filename);
  } catch (err) {
    logger.warn(
      { fileId, err: err instanceof Error ? err.message : String(err) },
      "delete_file.storage_unlink_failed",
    );
  }

  // Clean up track rows + sidecars before the file row is deleted.
  // Production DB may not have FK pragma on, so we delete explicitly.
  try {
    const trackRows = await listTracksByFile(db, fileId);
    for (const t of trackRows) {
      if (file.pieceId) await deleteTrackSidecar(file.pieceId, t.id);
      await deleteTrackRow(db, t.id);
    }
  } catch (err) {
    logger.warn(
      { fileId, err: err instanceof Error ? err.message : String(err) },
      "delete_file.tracks_cleanup_failed",
    );
  }

  db.delete(files).where(eq(files.id, fileId)).run();

  let cascade = { removedClips: [] as string[], removedOverlays: [] as string[] };
  if (file.pieceId) {
    try {
      cascade = await removeReferencesToFile(file.pieceId, fileId);
    } catch (err) {
      logger.warn(
        { fileId, pieceId: file.pieceId, err: err instanceof Error ? err.message : String(err) },
        "delete_file.cascade_failed",
      );
    }
  }

  logger.info(
    { fileId, filename: file.filename, ...cascade },
    "delete_file.done",
  );

  return {
    success: true,
    fileId,
    filename: file.filename,
    ...cascade,
  };
}
