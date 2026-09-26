import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces, templates } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { removeAnalysisForPiece } from "@/lib/analysis/cleanup";
import { navigationEmitter } from "@/lib/navigation-events";
import { clearRenderDiagnostics } from "@/lib/render/render-diagnostics-store";
import { forgetLegacyScenesNoticed } from "@/lib/db/settings";

/**
 * Fully delete a piece: DB row (files/assets/etc. cascade), on-disk storage
 * directory, analysis byproducts, the in-memory render diagnostics and its id in the
 * legacy-scenes notice memory (settings). Emits refresh_query — for
 * `templates` too when the piece was a template's source: its card stops offering "Render preview"
 * (the FK nulls `createdFromPieceId`). Returns false if the piece did not exist.
 */
export async function deletePieceCompletely(pieceId: string): Promise<boolean> {
  const db = getDb();
  const wasTemplateSource = !!db.select({ id: templates.id }).from(templates).where(eq(templates.createdFromPieceId, pieceId)).get();
  const [deleted] = await db.delete(pieces).where(eq(pieces.id, pieceId)).returning();
  if (!deleted) return false;

  const storage = await getStorage();
  removeAnalysisForPiece(pieceId);
  clearRenderDiagnostics(pieceId);
  forgetLegacyScenesNoticed(pieceId);
  await storage.deletePieceDir(pieceId);

  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
  navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId });
  if (wasTemplateSource) navigationEmitter.emit("refresh_query", { queryKey: "templates" });
  return true;
}
