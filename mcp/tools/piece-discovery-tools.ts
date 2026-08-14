import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { and, desc, eq, like, or, ne } from "drizzle-orm";
import { getOpenedPieceId, setOpenedPieceId } from "@/lib/editor-state";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";
import type { ToolResult } from "./types";

/** Validator-safe blank canvas body — paints a full-frame dark background.
 *  `width`/`height` are injected into draw-fn scope by the renderer; the
 *  numeric fallback keeps it correct even if a backend omits them.
 *  No longer seeded into new pieces (they start empty), but still exported:
 *  `video-scene-tools.ts` matches against it to auto-evict any legacy
 *  pristine-placeholder scene that an older piece may still carry. */
export const DEFAULT_SCENE_DRAW_FUNCTION =
  "const w = typeof width === 'number' ? width : 1920;\n" +
  "const h = typeof height === 'number' ? height : 1080;\n" +
  "ctx.fillStyle = '#0b0b0c';\n" +
  "ctx.fillRect(0, 0, w, h);";

const PIECE_TEXT_CAP = 280;

function truncate(value: string | null, cap = PIECE_TEXT_CAP): string | null {
  if (value == null) return null;
  return value.length > cap ? value.slice(0, cap - 1) + "…" : value;
}

/**
 * F5: a piece row carries a full Script JSON (`script` column) plus arbitrarily
 * long `description` / `snapshotSummary` text. Returning ~20 of those verbatim
 * overflows the agent's per-tool token limit (~75 KB observed) — the list gets
 * dumped to a file the agent then has to scrape. A discovery listing never needs
 * the script blob, so drop it and bound the free-text fields. The full script is
 * still reachable per-file via the Script tab / `analysis_get`.
 */
function leanPiece(row: typeof pieces.$inferSelect) {
  const { description, snapshotSummary, ...rest } = row;
  return {
    ...rest,
    description: truncate(description),
    snapshotSummary: truncate(snapshotSummary),
  };
}

export async function listPieces(params: {
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<ToolResult> {
  const db = getDb();
  const openedId = getOpenedPieceId();
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;

  // Get opened piece separately
  let openedPiece = null;
  if (openedId) {
    const row = db.select().from(pieces).where(eq(pieces.id, openedId)).get();
    if (row) openedPiece = leanPiece(row);
  }

  // Build query for remaining pieces
  const conditions = [];
  if (params.query) {
    const pattern = `%${params.query}%`;
    conditions.push(or(like(pieces.name, pattern), like(pieces.description, pattern)));
  }
  if (openedId) {
    conditions.push(ne(pieces.id, openedId));
  }

  let q = db.select().from(pieces);
  const combined = conditions.filter(Boolean);
  if (combined.length > 0) {
    q = q.where(and(...combined)) as typeof q;
  }
  const rows = q.orderBy(desc(pieces.updatedAt)).limit(limit).offset(offset).all();

  return {
    success: true,
    data: { openedPiece, pieces: rows.map(leanPiece) },
  };
}

export async function createPiece(params: {
  name?: string;
  description?: string;
}): Promise<ToolResult> {
  const db = getDb();
  const now = new Date();
  const name =
    params.name ||
    `New Piece ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  const [piece] = db
    .insert(pieces)
    .values({
      name,
      description: params.description ?? null,
    })
    .returning()
    .all();

  // New pieces start EMPTY (scenes: []). The preview renders a black canvas
  // plus a non-blocking hint (see preview-player.tsx), so there's no longer a
  // "reads as broken" empty state to paper over with a seeded scene. The agent
  // adds real content (video scene, overlay, etc.) when the user asks.
  return { success: true, data: piece };
}

/**
 * Permanently delete a piece and everything it owns — DB row (files, jobs,
 * folders, analysis, tracks cascade) plus the on-disk storage directory
 * (originals, proxies, filmstrips, overlay code, snapshots). Irreversible.
 *
 * Wraps the shared `deletePieceCompletely` helper (the same one the UI's DELETE
 * route calls) so the two paths can never diverge. When the deleted piece was
 * the one open in the editor, the in-memory opened-piece pointer is cleared so
 * `list_pieces` / the proxy LRU don't reference a dead piece; `wasOpen` is
 * returned so the caller (server.ts) can navigate the UI away.
 */
export async function deletePiece(params: { pieceId: string }): Promise<ToolResult> {
  const wasOpen = params.pieceId === getOpenedPieceId();
  const deleted = await deletePieceCompletely(params.pieceId);
  if (!deleted) return { success: false, error: "piece_not_found" };
  if (wasOpen) setOpenedPieceId(null);
  return { success: true, data: { pieceId: params.pieceId, wasOpen } };
}
