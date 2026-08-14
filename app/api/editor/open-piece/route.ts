import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { setOpenedPieceId } from "@/lib/editor-state";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import { serverLogger as logger } from "@/lib/logger";

export async function POST(request: Request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const pieceId = typeof body.pieceId === "string" ? body.pieceId : null;
  setOpenedPieceId(pieceId);

  // Stamp the open so the "No piece open" panel can offer a real recents list.
  // This route is the single chokepoint every open flows through — a click in
  // the resources tree, the restore-last-piece effect on boot, and the agent's
  // `libi.show_piece` (which reaches the editor as an SSE navigation event and
  // ends up here like any other open).
  //
  // `updatedAt` is deliberately NOT touched: it means "last modified", it
  // orders the resources tree, and moving it on a read would make merely
  // looking at a piece indistinguishable from editing it.
  //
  // Failure here is non-fatal. The caller's only real job is telling the server
  // which piece is open (the proxy LRU protects it from eviction); losing a
  // recents timestamp must never break that.
  if (pieceId) {
    try {
      await getDb()
        .update(pieces)
        .set({ lastOpenedAt: new Date() })
        .where(eq(pieces.id, pieceId));
    } catch (err) {
      logger.warn(
        { tag: "editor-state", op: "stamp_last_opened_failed", pieceId, err },
        "Could not record the piece open time — recents ordering may be stale",
      );
    }
  }

  return NextResponse.json({ success: true });
}
