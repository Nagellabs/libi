import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { deleteFile } from "@/lib/files/delete-file";
import { navigationEmitter } from "@/lib/navigation-events";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

/**
 * GET /api/files/by-id/[fileId]
 *
 * Returns the file record by id, or 404 if missing. Used by the chat
 * thumbnail chip to (a) verify the file still exists in the resources
 * tree and (b) resolve its `pieceId` so click-to-open can switch the
 * editor to the right piece. No piece scope on the URL because chat
 * attachments are looked up by id, not piece — the file may have been
 * uploaded as global, assigned to a piece, or moved between pieces
 * since it was attached.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { fileId } = await params;
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ file: row });
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const { fileId } = await params;
  const db = getDb();
  const [pre] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  const pieceIdForRefresh = pre?.pieceId ?? null;

  const result = await deleteFile(fileId);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  if (pieceIdForRefresh) {
    navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId: pieceIdForRefresh });
  } else {
    navigationEmitter.emit("refresh_query", { queryKey: "files" });
  }

  return NextResponse.json(result);
}
