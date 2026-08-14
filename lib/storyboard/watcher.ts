import { eq } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { loadStoryboard } from "./repo";
import { storyboardMatchesSnapshot } from "./snapshot";
import { renderCardSketches } from "./render-card";

/** Validate the on-disk storyboard for a piece and, when valid, flip the
 *  draft + notify the UI. Pure-ish: takes a pieceId, does IO, returns a
 *  result. The chokidar wiring (below) just calls this, debounced. */
export async function handleStoryboardChange(
  pieceId: string,
): Promise<{ ok: boolean; error?: string }> {
  let sb;
  try {
    sb = await loadStoryboard(pieceId); // throws if any card.json / manifest is invalid
  } catch (err) {
    logger.warn({ err, pieceId, tag: "storyboard", op: "watch_invalid" }, "invalid storyboard edit");
    return { ok: false, error: (err as Error).message };
  }
  // Regenerate sketch slot PNGs for cards that have render units. Writes only
  // per-slot PNGs (watcher-ignored), so this never re-triggers the watcher.
  if (sb) {
    for (const card of sb.cards) {
      try {
        await renderCardSketches(pieceId, card);
      } catch (err) {
        logger.warn({ err, pieceId, cardId: card.id, tag: "storyboard", op: "sketch_render_failed" }, "sketch render failed");
      }
    }
  }
  // Draft-flip: a direct file edit is a draft mutation. Mirror saveManifest's
  // signal without rewriting composition.json. Gate on divergence from the
  // committed snapshot so migration writes don't count as draft edits.
  try {
    if (!(await storyboardMatchesSnapshot(pieceId))) {
      const db = getDb();
      const [row] = await db.select({ hasDraft: pieces.hasDraft }).from(pieces).where(eq(pieces.id, pieceId));
      if (row && !row.hasDraft) {
        await db.update(pieces).set({ hasDraft: true, updatedAt: new Date() }).where(eq(pieces.id, pieceId));
        navigationEmitter.emit("refresh_query", { queryKey: "piece-state", pieceId });
      }
    }
  } catch (err) {
    // DB not ready or piece not found — skip the draft-flip but still emit the
    // storyboard refresh so the UI invalidates.
    logger.warn({ err, pieceId, tag: "storyboard", op: "watch_draft_flip_skip" }, "draft-flip skipped");
  }
  navigationEmitter.emit("refresh_query", { queryKey: "storyboard", pieceId });
  return { ok: true };
}
