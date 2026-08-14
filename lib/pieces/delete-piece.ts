import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { removeAnalysisForPiece } from "@/lib/analysis/cleanup";
import { navigationEmitter } from "@/lib/navigation-events";

/**
 * Fully delete a piece: DB row (files/assets/etc. cascade), on-disk storage
 * directory, and analysis byproducts. Emits refresh_query. Returns false if
 * the piece did not exist.
 */
export async function deletePieceCompletely(pieceId: string): Promise<boolean> {
  const db = getDb();
  const [deleted] = await db.delete(pieces).where(eq(pieces.id, pieceId)).returning();
  if (!deleted) return false;

  const storage = await getStorage();
  removeAnalysisForPiece(pieceId);
  await storage.deletePieceDir(pieceId);

  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
  navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId });
  return true;
}
