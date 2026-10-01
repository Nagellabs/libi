import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, pieces, templates } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { removeAnalysisForPiece } from "@/lib/analysis/cleanup";
import { navigationEmitter } from "@/lib/navigation-events";
import { clearRenderDiagnostics } from "@/lib/render/render-diagnostics-store";
import { forgetLegacyScenesNoticed } from "@/lib/db/settings";
import { forgetRemovedTranscriptsForPiece } from "@/lib/analysis/removed-transcripts";
import { forgetEvictedProxies } from "@/lib/proxy/evicted";

/**
 * Fully delete a piece: DB row (files/assets/etc. cascade), on-disk storage
 * directory, analysis byproducts, the in-memory render diagnostics, its id in the
 * legacy-scenes notice memory (settings), its removed-transcript notices and its files' proxy-eviction
 * records (lib/proxy/evicted.ts). Emits refresh_query — for
 * `templates` too when the piece was a template's source: its card stops offering "Render preview"
 * (the FK nulls `createdFromPieceId`). Returns false if the piece did not exist.
 */
export async function deletePieceCompletely(pieceId: string): Promise<boolean> {
  const db = getDb();
  const wasTemplateSource = !!db.select({ id: templates.id }).from(templates).where(eq(templates.createdFromPieceId, pieceId)).get();
  // Read before the delete: the cascade takes the file rows with it.
  const fileIds = db.select({ id: files.id }).from(files).where(eq(files.pieceId, pieceId)).all().map((f) => f.id);
  const [deleted] = await db.delete(pieces).where(eq(pieces.id, pieceId)).returning();
  if (!deleted) return false;

  const storage = await getStorage();
  removeAnalysisForPiece(pieceId);
  clearRenderDiagnostics(pieceId);
  forgetLegacyScenesNoticed(pieceId);
  forgetRemovedTranscriptsForPiece(pieceId);
  forgetEvictedProxies(fileIds);
  await storage.deletePieceDir(pieceId);

  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
  navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId });
  if (wasTemplateSource) navigationEmitter.emit("refresh_query", { queryKey: "templates" });
  return true;
}
